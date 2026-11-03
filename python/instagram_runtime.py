"""Instagram operations with no local session files or interactive SDK input."""

import asyncio
import base64
import binascii
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import threading
import time
from urllib.parse import urlsplit


ERRORS = {
    'AUTH_REQUIRED': 'Instagram authorization required; complete verification manually if necessary',
    'STORAGE_ERROR': 'Instagram session storage failed',
    'PROVIDER_ERROR': 'Instagram request failed',
    'UNSUPPORTED_OPERATION': 'Instagram operation is not supported',
}


def create_client():
    from instagrapi import Client
    from instagrapi.utils.timing import random_delay

    class SingleAttemptClient(Client):
        def set_settings(self, settings):
            return super().set_settings({**settings, 'session_retry_total': 0})

        def private_request(self, endpoint, data=None, params=None, login=False,
                            with_signature=True, headers=None, extra_sig=None, domain=None):
            if not endpoint.startswith('direct_v2/threads/broadcast/'):
                return super().private_request(endpoint, data=data, params=params, login=login,
                    with_signature=with_signature, headers=headers, extra_sig=extra_sig, domain=domain)
            if self.authorization:
                headers = dict(headers or {})
                if 'authorization' not in headers:
                    headers['Authorization'] = self.authorization
            if self.delay_range:
                random_delay(delay_range=self.delay_range)
            self.private_requests_count += 1
            # A lost response cannot establish whether Instagram already sent the message.
            self._send_private_request(endpoint, data=data, params=params, login=login,
                with_signature=with_signature, headers=headers, extra_sig=extra_sig, domain=domain)
            return self.last_json

    return SingleAttemptClient(session_retry_total=0)


class BridgeError(RuntimeError):
    def __init__(self, code):
        self.code = code if code in ERRORS else 'PROVIDER_ERROR'
        super().__init__(ERRORS[self.code])


def safe_error(error):
    if isinstance(error, BridgeError):
        return error
    names = {cls.__name__ for cls in type(error).__mro__}
    auth_errors = {'LoginRequired', 'ClientLoginRequired', 'BadPassword', 'BadCredentials',
                   'TwoFactorRequired', 'ChallengeError', 'ChallengeRequired',
                   'ChallengeUnknownStep', 'ChallengeSelfieCaptcha', 'SelectContactPointRecoveryForm'}
    return BridgeError('AUTH_REQUIRED' if names & auth_errors else 'PROVIDER_ERROR')


def identifier(value):
    # DirectThread.pk is a different Instagram identifier; always prefer .id.
    result = getattr(value, 'id', None) or getattr(value, 'pk', None)
    if result is None:
        raise BridgeError('PROVIDER_ERROR')
    return str(result)


def utc(value):
    if not isinstance(value, datetime):
        raise BridgeError('PROVIDER_ERROR')
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def field(value, name, default=None):
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


def best_version(versions):
    versions = versions or []
    if not versions:
        return None
    version = max(versions, key=lambda value: (field(value, 'width', 0) or 0) * (field(value, 'height', 0) or 0))
    return field(version, 'url')


def media_details(message):
    item_type = field(message, 'item_type')
    if item_type not in {'media', 'raven_media', 'visual_media', 'voice_media'}:
        raise BridgeError('UNSUPPORTED_OPERATION')
    media = field(message, 'media')
    if media is None:
        media = field(field(message, 'visual_media'), 'media')
    if media is None:
        media = field(field(message, 'voice_media'), 'media')
    audio_url = field(media, 'audio_url') or field(field(media, 'audio'), 'audio_src')
    video_url = field(media, 'video_url') or best_version(field(media, 'video_versions'))
    if audio_url:
        return {'kind': 'audio', 'url': str(audio_url), 'mimeType': 'audio/mp4'}
    if video_url:
        return {'kind': 'video', 'url': str(video_url), 'mimeType': 'video/mp4'}
    image_url = field(media, 'thumbnail_url') or best_version(field(field(media, 'image_versions2'), 'candidates'))
    if image_url and field(media, 'media_type') == 1:
        suffix = Path(urlsplit(str(image_url)).path).suffix.lower()
        mime = {'.png': 'image/png', '.webp': 'image/webp'}.get(suffix, 'image/jpeg')
        return {'kind': 'photo', 'url': str(image_url), 'mimeType': mime}
    raise BridgeError('UNSUPPORTED_OPERATION')


def attachments(message, chat_id):
    kind = field(message, 'item_type')
    if not kind or kind == 'text':
        return []
    result = {'kind': str(kind), 'referencePayload': {
        'chatId': str(chat_id), 'messageId': identifier(message), 'index': 0,
    }}
    try:
        details = media_details(message)
        result.update({key: details[key] for key in ('kind', 'mimeType')})
    except BridgeError:
        pass
    return [result]


def normalize_message(message, chat_id, account_id, self_id, users):
    sender = str(getattr(message, 'user_id', None) or '')
    outgoing = sender == str(self_id) or bool(getattr(message, 'is_sent_by_viewer', False))
    if not sender and outgoing:
        sender = str(self_id)
    kind = getattr(message, 'item_type', None)
    result = {
        'provider': 'instagram', 'accountId': account_id, 'chatId': str(chat_id),
        'messageId': f'{chat_id}:{identifier(message)}', 'senderId': sender,
        'direction': 'outgoing' if outgoing else 'incoming',
        'text': getattr(message, 'text', None) or '',
        'sentAt': utc(message.timestamp).isoformat(timespec='microseconds').replace('+00:00', 'Z'),
        'attachments': attachments(message, chat_id),
    }
    user = users.get(sender)
    if user is not None:
        if getattr(user, 'full_name', None):
            result['displayName'] = user.full_name
        elif getattr(user, 'username', None):
            result['displayName'] = user.username
        if getattr(user, 'username', None):
            result['username'] = user.username
    return result


class InstagramRuntime:
    def __init__(self, client_factory, rpc, emit):
        self.client_factory = client_factory
        self.rpc = rpc
        self.emit = emit
        self.client = None
        self.account_id = ''
        self.self_id = ''
        self.connected = False
        self.stopped = False
        self.seen = OrderedDict()
        self.cutoff = None
        self.interval = 15
        self.loop = None
        self.poller = None
        self.authenticating = False
        self.challenge_attempts = 0
        self.lock = asyncio.Lock()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='instagram')
        self.media_directories = set()
        self.media_lock = threading.Lock()

    def _send_media(self, params):
        media = params['media']
        if media.get('caption'):
            raise BridgeError('UNSUPPORTED_OPERATION')
        formats = {
            ('photo', 'image/jpeg'): ('.jpg', 'direct_send_photo'),
            ('photo', 'image/png'): ('.png', 'direct_send_photo'),
            ('photo', 'image/webp'): ('.webp', 'direct_send_photo'),
            ('video', 'video/mp4'): ('.mp4', 'direct_send_video'),
            ('audio', 'audio/mp4'): ('.m4a', 'direct_send_voice'),
            ('audio', 'audio/x-m4a'): ('.m4a', 'direct_send_voice'),
        }
        selected = formats.get((media.get('kind'), media.get('mimeType')))
        if selected is None:
            raise BridgeError('UNSUPPORTED_OPERATION')
        encoded = media.get('data')
        if not isinstance(encoded, str) or len(encoded) > 28 * 1024 * 1024:
            raise BridgeError('PROVIDER_ERROR')
        try:
            data = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError):
            raise BridgeError('PROVIDER_ERROR') from None
        if not data or len(data) > 20 * 1024 * 1024:
            raise BridgeError('PROVIDER_ERROR')
        suffix, method = selected
        with self.media_lock:
            if self.stopped:
                raise BridgeError('PROVIDER_ERROR')
            directory = tempfile.TemporaryDirectory(prefix='chatmeld-instagram-')
            self.media_directories.add(directory)
        try:
            path = Path(directory.name) / ('upload' + suffix)
            path.write_bytes(data)
            return getattr(self.client, method)(path, thread_ids=[int(params['chatId'])])
        finally:
            directory.cleanup()
            with self.media_lock:
                self.media_directories.discard(directory)

    def _download_media(self, payload):
        if payload.get('index') != 0:
            raise BridgeError('UNSUPPORTED_OPERATION')
        endpoint = f"direct_v2/threads/{int(payload['chatId'])}/"
        params = {'visual_message_return_type': 'unseen', 'direction': 'older',
                  'seq_id': '40065', 'limit': '20'}
        cursors = set()
        deadline = time.monotonic() + 70
        for _ in range(100):
            if time.monotonic() >= deadline:
                raise BridgeError('UNSUPPORTED_OPERATION')
            page = self.client.private_request(endpoint, params=dict(params))['thread']
            for item in page.get('items', []):
                if str(item.get('item_id')) == str(payload['messageId']):
                    details = media_details(item)
                    return {'url': details['url'], 'mimeType': details['mimeType']}
            cursor = page.get('oldest_cursor')
            if not cursor:
                raise BridgeError('UNSUPPORTED_OPERATION')
            if cursor in cursors:
                raise BridgeError('UNSUPPORTED_OPERATION')
            cursors.add(cursor)
            params['cursor'] = cursor
        raise BridgeError('UNSUPPORTED_OPERATION')

    def _rpc(self, event, timeout):
        future = asyncio.run_coroutine_threadsafe(self.rpc(event, timeout), self.loop)
        try:
            return future.result(timeout=timeout + 1)
        except BaseException:
            future.cancel()
            raise

    def _persist(self):
        try:
            settings = self.client.get_settings()
            # SDK 3.2.2 does not return credentials. Guard this boundary if that changes.
            settings = {k: v for k, v in settings.items() if k not in {'password', 'verification_code'}}
            self._rpc({'event': 'session', 'settings': settings}, 45)
        except BaseException:
            self.stopped = True
            raise BridgeError('STORAGE_ERROR') from None

    def _code(self, *args, **kwargs):
        if not self.authenticating or self.challenge_attempts >= 3:
            raise BridgeError('AUTH_REQUIRED')
        self.challenge_attempts += 1
        code = self._rpc({'event': 'challenge', 'kind': 'code',
                          'prompt': 'Enter the Instagram verification code',
                          'pattern': r'^\d{6,8}$'}, 165)
        if not isinstance(code, str) or not code.strip():
            raise BridgeError('AUTH_REQUIRED')
        return code

    @staticmethod
    def _no_password_change(*args, **kwargs):
        raise BridgeError('AUTH_REQUIRED')

    def _remember(self, key):
        self.seen[key] = None
        self.seen.move_to_end(key)
        while len(self.seen) > 2000:
            self.seen.popitem(last=False)

    def _users(self, thread):
        return {str(user.pk): user for user in [*(getattr(thread, 'users', None) or []),
                                                *(getattr(thread, 'left_users', None) or [])]}

    def _initialize(self, method, params):
        if method == 'connect' and not isinstance(params.get('settings'), dict):
            raise BridgeError('AUTH_REQUIRED')
        if self.client is not None:
            raise BridgeError('PROVIDER_ERROR')
        self.account_id = params['accountId']
        username = params['username']
        if not isinstance(username, str) or not username.strip():
            raise BridgeError('AUTH_REQUIRED')
        self.client = self.client_factory()
        self.client.challenge_code_handler = self._code
        self.client.change_password_handler = self._no_password_change
        password = None
        code = None
        self.authenticating = method == 'login'
        try:
            if isinstance(params.get('settings'), dict):
                self.client.set_settings(params['settings'])
            if method == 'login':
                password = self._rpc({'event': 'challenge', 'kind': 'password',
                                      'prompt': 'Enter your Instagram password'}, 165)
                if not isinstance(password, str) or not password:
                    raise BridgeError('AUTH_REQUIRED')
                for attempt in range(4):
                    try:
                        if code is None:
                            self.client.login(username, password)
                        else:
                            self.client.login(username, password, verification_code=code)
                        break
                    except Exception as error:
                        if type(error).__name__ != 'TwoFactorRequired' or attempt == 3:
                            raise
                        code = self._code()
            account = self.client.account_info()
            self.self_id = str(account.pk)
            if (str(account.username).casefold() != username.casefold()
                    or str(self.client.user_id) != self.self_id):
                raise BridgeError('AUTH_REQUIRED')
            self.cutoff = datetime.now(timezone.utc)
            threads = self.client.direct_threads(amount=20, thread_message_limit=20)
            for thread in threads:
                for message in thread.messages:
                    self._remember(f'{identifier(thread)}:{identifier(message)}')
            self._persist()
            self.connected = True
            self.interval = max(15, float(params.get('pollIntervalSeconds', 15)))
            return {'ok': True}
        finally:
            self.authenticating = False
            self.client.password = None
            password = None
            code = None

    def _command(self, method, params):
        if self.stopped:
            raise BridgeError('PROVIDER_ERROR')
        if method in {'login', 'connect'}:
            return self._initialize(method, params)
        if not self.connected:
            raise BridgeError('AUTH_REQUIRED')
        if method == 'chats':
            threads = self.client.direct_threads(amount=0, thread_message_limit=1)
            result = []
            for thread in threads:
                title = getattr(thread, 'thread_title', None)
                if not title:
                    title = ', '.join((getattr(user, 'full_name', None) or getattr(user, 'username', None) or str(user.pk))
                                      for user in thread.users if str(user.pk) != self.self_id)
                result.append({'id': identifier(thread), 'title': title or identifier(thread)})
        elif method == 'history':
            limit = max(1, min(100, int(params.get('limit', 50))))
            chat_id = str(params['chatId'])
            thread = self.client.direct_thread(int(chat_id), amount=limit)
            result = [normalize_message(m, chat_id, self.account_id, self.self_id, self._users(thread))
                      for m in sorted(thread.messages, key=lambda m: utc(m.timestamp), reverse=True)[:limit]]
        elif method == 'send':
            chat_id = str(params['chatId'])
            message = self.client.direct_send(params['text'], thread_ids=[int(chat_id)])
            result = {'externalId': f'{chat_id}:{identifier(message)}'}
        elif method == 'sendMedia':
            message = self._send_media(params)
            result = {'externalId': f"{params['chatId']}:{identifier(message)}"}
        elif method == 'downloadMedia':
            result = self._download_media(params['payload'])
        elif method == 'avatar':
            target = params['target']
            if target['type'] == 'user':
                user = self.client.user_info_v1(str(int(target['id'])))
                picture = getattr(user, 'profile_pic_url', None)
            elif target['type'] == 'chat':
                thread = self.client.direct_thread(int(target['id']), amount=1)
                participants = [user for user in thread.users if str(user.pk) != self.self_id]
                # SDK 3.2.2 DirectThread has no group picture field.
                picture = None
                if not getattr(thread, 'is_group', False) and len(participants) == 1:
                    picture = getattr(participants[0], 'profile_pic_url', None)
            else:
                raise BridgeError('PROVIDER_ERROR')
            result = str(picture) if picture else None
        else:
            raise BridgeError('PROVIDER_ERROR')
        self._persist()
        return result

    async def command(self, method, params):
        self.loop = asyncio.get_running_loop()
        async with self.lock:
            try:
                result = await self.loop.run_in_executor(self.executor, self._command, method, params)
            except Exception as error:
                raise safe_error(error) from None
            if method in {'login', 'connect'}:
                self.poller = asyncio.create_task(self._poll_loop())
            return result

    def _poll(self):
        if self.stopped or not self.connected:
            raise BridgeError('PROVIDER_ERROR')
        threads = self.client.direct_threads(amount=20, thread_message_limit=20)
        messages = []
        for thread in threads:
            chat_id = identifier(thread)
            users = self._users(thread)
            for message in thread.messages:
                normalized = normalize_message(message, chat_id, self.account_id, self.self_id, users)
                key = normalized['messageId']
                if key in self.seen:
                    continue
                self._remember(key)
                if normalized['direction'] == 'incoming' and utc(message.timestamp) >= self.cutoff:
                    messages.append(normalized)
        self._persist()
        return sorted(messages, key=lambda message: (message['sentAt'], message['messageId']))

    async def poll_once(self):
        self.loop = asyncio.get_running_loop()
        async with self.lock:
            try:
                messages = await self.loop.run_in_executor(self.executor, self._poll)
            except Exception as error:
                raise safe_error(error) from None
            for message in messages:
                self.emit({'event': 'message', 'message': message})

    async def _poll_loop(self):
        try:
            while not self.stopped:
                await asyncio.sleep(self.interval)
                await self.poll_once()
        except asyncio.CancelledError:
            pass
        except Exception as error:
            self.stopped = True
            self.emit({'event': 'fatal', 'code': safe_error(error).code})

    async def close(self):
        self.stopped = True
        with self.media_lock:
            for directory in self.media_directories:
                directory.cleanup()
        if self.poller is not None:
            self.poller.cancel()
            await asyncio.gather(self.poller, return_exceptions=True)
        if self.client is not None:
            self.client.password = None
            for name in ('private', 'public'):
                session = getattr(self.client, name, None)
                if session is not None:
                    try:
                        session.close()
                    except Exception:
                        pass
        self.executor.shutdown(wait=False, cancel_futures=True)
