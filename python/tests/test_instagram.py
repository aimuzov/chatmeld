import asyncio
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace as O
from instagram_runtime import InstagramRuntime, BridgeError, normalize_message
from instagram_bridge import EventRpc
import base64
import importlib.util
from pathlib import Path
import threading
from unittest.mock import patch
CHAT = '340282366841710300949128531777654287254'
MID = '28597946203914980615241927545176064'
NOW = datetime.now(timezone.utc)

def msg(id=MID, user='2', at=NOW, text='hi', kind='text'):
    return O(id=id, user_id=user, timestamp=at, text=text, item_type=kind, is_sent_by_viewer=user == '1')

def thread(messages=None):
    return O(id=CHAT, pk='wrong', thread_title='', users=[O(pk='1', username='me', full_name='Self'), O(pk='2', username='friend', full_name='Friend Name')], messages=messages or [])

class TwoFactorRequired(Exception):
    pass

class LoginRequired(Exception):
    pass

class FakeClient:

    def __init__(self):
        self.password = None
        self.user_id = 1
        self.settings = {'cookies': {'ds_user_id': '1'}}
        self.threads = [thread([msg(at=NOW - timedelta(minutes=1))])]
        self.calls = []
        self.two_factor = self.challenge = self.revoked = self.direct_error = False

    def set_settings(self, settings):
        self.settings = settings

    def get_settings(self):
        return self.settings

    def login(self, username, password, verification_code=''):
        self.calls.append(('login', username, password, verification_code))
        self.password = password
        if self.two_factor and verification_code != '123456':
            raise TwoFactorRequired('secret')
        if self.challenge:
            self.challenge_code_handler(username, 1)
        return True

    def account_info(self):
        if self.revoked:
            raise LoginRequired('secret')
        return O(pk='1', username='Me')

    def direct_threads(self, **kwargs):
        self.calls.append(('threads', kwargs))
        if self.direct_error:
            raise RuntimeError('secret')
        return self.threads

    def direct_thread(self, chat_id, amount):
        self.calls.append(('history', chat_id, amount))
        return self.threads[0]

    def private_request(self, endpoint, params=None):
        return {'thread': {'items': [dict(vars(item), item_id=item.id) for item in self.threads[0].messages]}}

    def direct_send(self, text, thread_ids):
        self.calls.append(('send', text, thread_ids))
        return msg(user='1')

class RuntimeTests(unittest.IsolatedAsyncioTestCase):

    async def asyncSetUp(self):
        self.client = FakeClient()
        self.events, self.requests = ([], [])
        self.fail_storage = False

        async def rpc(event, timeout):
            self.requests.append(event)
            if event['event'] == 'session':
                if self.fail_storage:
                    raise BridgeError('STORAGE_ERROR')
                return None
            return 'password-secret' if event['kind'] == 'password' else '123456'
        self.runtime = InstagramRuntime(lambda: self.client, rpc, self.events.append)
        self.params = {'accountId': 'one', 'username': 'me', 'settings': self.client.settings, 'pollIntervalSeconds': 15}

    async def asyncTearDown(self):
        await self.runtime.close()

    async def connect(self):
        await self.runtime.command('connect', self.params)

    async def test_missing_session_never_logs_in(self):
        with self.assertRaises(BridgeError) as e:
            await self.runtime.command('connect', {**self.params, 'settings': None})
        self.assertEqual(e.exception.code, 'AUTH_REQUIRED')
        self.assertEqual(self.client.calls, [])

    async def test_restore_verifies_and_persists_without_login(self):
        await self.connect()
        self.assertFalse(any((c[0] == 'login' for c in self.client.calls)))
        self.assertEqual(self.requests[-1]['event'], 'session')
        self.assertEqual(self.events, [])

    async def test_revoked_restore(self):
        self.client.revoked = True
        with self.assertRaises(BridgeError) as e:
            await self.connect()
        self.assertEqual(e.exception.code, 'AUTH_REQUIRED')
        self.assertNotIn('secret', str(e.exception))

    async def test_foreign_restore(self):
        self.params['username'] = 'other'
        with self.assertRaises(BridgeError) as e:
            await self.connect()
        self.assertEqual(e.exception.code, 'AUTH_REQUIRED')

    async def test_direct_access_required(self):
        self.client.direct_error = True
        with self.assertRaises(BridgeError):
            await self.connect()
        self.assertFalse(any((r['event'] == 'session' for r in self.requests)))

    async def test_login_2fa_challenge_password_cleared(self):
        self.client.two_factor = self.client.challenge = True
        await self.runtime.command('login', self.params)
        self.assertEqual([r['kind'] for r in self.requests if r['event'] == 'challenge'], ['password', 'code', 'code'])
        self.assertIsNone(self.client.password)
        self.assertNotIn('password-secret', str([r for r in self.requests if r['event'] == 'session']))

    async def test_two_factor_bounded(self):
        self.client.two_factor = True

        async def wrong(event, timeout):
            return 'wrong'
        self.runtime.rpc = wrong
        with self.assertRaises(BridgeError):
            await self.runtime.command('login', self.params)
        self.assertEqual(len(self.client.calls), 4)
        self.assertIsNone(self.client.password)

    async def test_change_password_disabled(self):
        await self.connect()
        with self.assertRaises(BridgeError):
            self.client.change_password_handler('me')

    async def test_chats_history_send(self):
        await self.connect()
        self.assertEqual(await self.runtime.command('chats', {}), [{
            'id': CHAT,
            'title': 'Friend Name',
            'profileUrl': 'https://www.instagram.com/friend/',
        }])
        self.assertEqual(self.client.calls[-1], ('threads', {'amount': 0, 'thread_message_limit': 1}))
        history = await self.runtime.command('history', {'chatId': CHAT, 'limit': 999})
        self.assertEqual(history[0]['displayName'], 'Friend Name')
        self.assertEqual(history[0]['username'], 'friend')
        self.assertIn(('history', int(CHAT), 100), self.client.calls)
        self.assertEqual(await self.runtime.command('send', {'chatId': CHAT, 'text': 'hi'}), {'externalId': f'{CHAT}:{MID}'})

    async def test_poll_dedup_baseline_media_order_outgoing(self):
        await self.connect()
        at = datetime.now(timezone.utc) + timedelta(seconds=1)
        self.client.threads = [thread([msg('later', at=at + timedelta(seconds=1)), msg('out', user='1', at=at), msg('media', at=at, text=None, kind='media'), msg('old', at=NOW - timedelta(days=1))])]
        await self.runtime.poll_once()
        await self.runtime.poll_once()
        self.assertEqual([e['message']['messageId'] for e in self.events], [f'{CHAT}:media', f'{CHAT}:later'])
        self.assertEqual(self.events[0]['message']['attachments'], [{'kind': 'media', 'referencePayload': {'chatId': CHAT, 'messageId': 'media', 'index': 0}}])
        self.assertLessEqual(len(self.runtime.seen), 2000)

    async def test_storage_failure_stops_before_emit(self):
        await self.connect()
        self.fail_storage = True
        self.client.threads = [thread([msg('new', at=datetime.now(timezone.utc) + timedelta(seconds=1))])]
        with self.assertRaises(BridgeError) as e:
            await self.runtime.poll_once()
        self.assertEqual(e.exception.code, 'STORAGE_ERROR')
        self.assertEqual(self.events, [])
        with self.assertRaises(BridgeError):
            await self.runtime.command('chats', {})

    def test_normalize_huge_ids_utc_media_outgoing(self):
        value = normalize_message(msg(user='1', text=None, kind='voice_media'), CHAT, 'one', '1', {})
        self.assertEqual(value['direction'], 'outgoing')
        self.assertEqual(value['messageId'], f'{CHAT}:{MID}')
        self.assertEqual(value['text'], '')
        self.assertEqual(value['attachments'], [{'kind': 'voice_media', 'referencePayload': {'chatId': CHAT, 'messageId': MID, 'index': 0}}])
        self.assertTrue(value['sentAt'].endswith('Z'))

class RpcTests(unittest.IsolatedAsyncioTestCase):

    async def test_session_error_correlated(self):
        events = []
        rpc = EventRpc(events.append)
        task = asyncio.create_task(rpc.request({'event': 'session', 'settings': {}}, 1))
        await asyncio.sleep(0)
        rpc.respond({'requestId': events[0]['requestId'], 'error': 'secret'})
        with self.assertRaises(BridgeError) as e:
            await task
        self.assertEqual(e.exception.code, 'STORAGE_ERROR')
        rpc.close()

class RuntimeSafetyTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = RuntimeTests.asyncSetUp
    asyncTearDown = RuntimeTests.asyncTearDown
    connect = RuntimeTests.connect

    async def test_missing_media_reference_is_unsupported_and_session_stays_usable(self):
        await self.connect()
        with self.assertRaises(BridgeError) as error:
            await self.runtime.command('downloadMedia', {'payload': {
                'chatId': CHAT, 'messageId': 'deleted-message', 'index': 0,
            }})
        self.assertEqual(error.exception.code, 'UNSUPPORTED_OPERATION')
        self.assertTrue(self.runtime.connected)
        self.assertFalse(self.runtime.stopped)
        self.assertEqual(await self.runtime.command('chats', {}), [{
            'id': CHAT,
            'title': 'Friend Name',
            'profileUrl': 'https://www.instagram.com/friend/',
        }])

    async def test_download_sdk_auth_and_network_errors_keep_their_codes(self):
        await self.connect()
        for failure, code in [(LoginRequired('safe'), 'AUTH_REQUIRED'), (RuntimeError('safe'), 'PROVIDER_ERROR')]:
            with patch.object(self.client, 'private_request', side_effect=failure):
                with self.assertRaises(BridgeError) as error:
                    await self.runtime.command('downloadMedia', {'payload': {
                        'chatId': CHAT, 'messageId': MID, 'index': 0,
                    }})
                self.assertEqual(error.exception.code, code)

    async def test_download_stops_at_matching_page_even_when_cursor_remains(self):
        await self.connect()
        item = {'item_id': MID, 'item_type': 'media', 'media': {
            'media_type': 1, 'image_versions2': {'candidates': [
                {'width': 640, 'height': 480, 'url': 'https://cdn.example/photo.jpg'},
            ]},
        }}
        for pages in [[{'thread': {'items': [item], 'oldest_cursor': 'more'}}],
                      [{'thread': {'items': [], 'oldest_cursor': 'page2'}},
                       {'thread': {'items': [item], 'oldest_cursor': 'more'}}]]:
            with patch.object(self.client, 'private_request', side_effect=pages) as request:
                result = await self.runtime.command('downloadMedia', {'payload': {
                    'chatId': CHAT, 'messageId': MID, 'index': 0,
                }})
                self.assertEqual(result['url'], 'https://cdn.example/photo.jpg')
                self.assertEqual(request.call_count, len(pages))
                self.assertEqual(request.call_args.args[0], f'direct_v2/threads/{CHAT}/')
                if len(pages) == 2:
                    self.assertEqual(request.call_args.kwargs['params']['cursor'], 'page2')

    async def test_download_stops_repeating_cursor(self):
        await self.connect()
        with patch.object(self.client, 'private_request', return_value={
            'thread': {'items': [], 'oldest_cursor': 'stuck'},
        }) as request:
            with self.assertRaises(BridgeError) as error:
                await self.runtime.command('downloadMedia', {'payload': {
                    'chatId': CHAT, 'messageId': MID, 'index': 0,
                }})
            self.assertEqual(error.exception.code, 'UNSUPPORTED_OPERATION')
            self.assertEqual(request.call_count, 2)

    async def test_download_has_a_page_limit(self):
        await self.connect()
        pages = [{'thread': {'items': [], 'oldest_cursor': str(index)}} for index in range(101)]
        with patch.object(self.client, 'private_request', side_effect=pages) as request:
            with self.assertRaises(BridgeError) as error:
                await self.runtime.command('downloadMedia', {'payload': {
                    'chatId': CHAT, 'messageId': MID, 'index': 0,
                }})
            self.assertEqual(error.exception.code, 'UNSUPPORTED_OPERATION')
            self.assertEqual(request.call_count, 100)

    async def test_shutdown_cleans_temp_media_while_sdk_is_still_running(self):
        await self.connect()
        entered = threading.Event()
        release = threading.Event()
        paths = []
        def send(path, thread_ids):
            paths.append(Path(path))
            entered.set()
            release.wait(timeout=3)
            return msg()
        self.client.direct_send_photo = send
        task = asyncio.create_task(self.runtime.command('sendMedia', {'chatId': CHAT, 'media': {
            'kind': 'photo', 'mimeType': 'image/png', 'data': 'YWJj',
        }}))
        try:
            self.assertTrue(await asyncio.to_thread(entered.wait, 2))
            self.assertTrue(paths[0].is_file())
            await self.runtime.close()
            self.assertFalse(paths[0].parent.exists())
        finally:
            release.set()
            await asyncio.wait_for(task, 3)

    async def test_send_media_three_sdk_methods_and_temporary_cleanup(self):
        await self.connect()
        for kind, mime, suffix, method in [
            ('photo', 'image/png', '.png', 'direct_send_photo'),
            ('video', 'video/mp4', '.mp4', 'direct_send_video'),
            ('audio', 'audio/mp4', '.m4a', 'direct_send_voice'),
        ]:
            paths = []
            def send(path, thread_ids):
                paths.append(Path(path))
                self.assertEqual(Path(path).suffix, suffix)
                self.assertEqual(Path(path).read_bytes(), b'real-media-bytes')
                self.assertEqual(thread_ids, [int(CHAT)])
                return msg()
            setattr(self.client, method, send)
            result = await self.runtime.command('sendMedia', {'chatId': CHAT, 'media': {
                'kind': kind, 'data': base64.b64encode(b'real-media-bytes').decode(),
                'mimeType': mime, 'fileName': '../../evil.py',
            }})
            self.assertEqual(result, {'externalId': f'{CHAT}:{MID}'})
            self.assertFalse(paths[0].parent.exists())
            self.assertEqual(self.requests[-1]['event'], 'session')

    async def test_send_media_cleanup_on_sdk_failure(self):
        await self.connect()
        paths = []
        def fail(path, thread_ids):
            paths.append(Path(path))
            raise RuntimeError('secret SDK error')
        self.client.direct_send_photo = fail
        with self.assertRaises(BridgeError):
            await self.runtime.command('sendMedia', {'chatId': CHAT, 'media': {
                'kind': 'photo', 'mimeType': 'image/png', 'data': 'YWJj',
            }})
        self.assertFalse(paths[0].parent.exists())

    async def test_send_media_invalid_base64_oversize_and_caption_rejected(self):
        await self.connect()
        for data in ['not base64!', 'A' * (28 * 1024 * 1024 + 1),
                     base64.b64encode(b'a' * (20 * 1024 * 1024 + 1)).decode()]:
            with self.assertRaises(BridgeError):
                await self.runtime.command('sendMedia', {'chatId': CHAT, 'media': {
                    'kind': 'photo', 'mimeType': 'image/png', 'data': data,
                }})
        with self.assertRaises(BridgeError) as error:
            await self.runtime.command('sendMedia', {'chatId': CHAT, 'media': {
                'kind': 'audio', 'mimeType': 'audio/mp4', 'data': 'YWJj', 'caption': 'caption',
            }})
        self.assertEqual(error.exception.code, 'UNSUPPORTED_OPERATION')

    async def test_normalize_and_download_photo_video_audio_references(self):
        await self.connect()
        for kind, fields, mime in [
            ('photo', {'media_type': 1, 'thumbnail_url': 'https://cdn.example/photo.jpg'}, 'image/jpeg'),
            ('video', {'media_type': 2, 'video_url': 'https://cdn.example/video.mp4'}, 'video/mp4'),
            ('audio', {'media_type': 11, 'audio_url': 'https://cdn.example/audio.m4a'}, 'audio/mp4'),
        ]:
            media_message = msg()
            media_message.item_type = 'voice_media' if kind == 'audio' else 'media'
            media_message.media = O(**fields)
            media_message.pk = 'wrong-id'
            self.client.threads = [thread([media_message])]
            result = normalize_message(media_message, CHAT, 'one', '1', {})
            attachment = result['attachments'][0]
            self.assertEqual(attachment['kind'], kind)
            self.assertEqual(attachment['mimeType'], mime)
            self.assertEqual(attachment['referencePayload'], {'chatId': CHAT, 'messageId': MID, 'index': 0})
            downloaded = await self.runtime.command('downloadMedia', {'payload': attachment['referencePayload']})
            self.assertEqual(downloaded['mimeType'], mime)
            self.assertEqual(downloaded['url'], next(value for key,value in fields.items() if key.endswith('_url')))

    async def test_download_visual_versions_and_missing_or_unsupported(self):
        await self.connect()
        item = msg()
        item.item_type = 'raven_media'
        item.visual_media = O(media=O(media_type=2, video_versions=[O(url='https://cdn.example/movie.mp4',width=720,height=1280)]))
        self.client.threads = [thread([item])]
        payload = {'chatId': CHAT, 'messageId': MID, 'index': 0}
        result = await self.runtime.command('downloadMedia', {'payload': payload})
        self.assertEqual(result['url'], 'https://cdn.example/movie.mp4')
        with self.assertRaises(BridgeError):
            await self.runtime.command('downloadMedia', {'payload': {**payload, 'messageId': 'wrong-id'}})
        item.visual_media = None
        item.item_type = 'link'
        with self.assertRaises(BridgeError) as error:
            await self.runtime.command('downloadMedia', {'payload': payload})
        self.assertEqual(error.exception.code, 'UNSUPPORTED_OPERATION')

    async def test_avatar_user_url_and_session_ack(self):
        await self.connect()
        self.client.user_info_v1 = lambda user_id: O(profile_pic_url='https://cdn.example/user.jpg')
        result = await self.runtime.command('avatar', {'target': {'type': 'user', 'id': '2'}})
        self.assertEqual(result, 'https://cdn.example/user.jpg')
        self.assertEqual(self.requests[-1]['event'], 'session')

    async def test_avatar_direct_chat_uses_other_participant(self):
        await self.connect()
        self.client.threads[0].users[0].profile_pic_url = 'https://cdn.example/self.jpg'
        self.client.threads[0].users[1].profile_pic_url = 'https://cdn.example/friend.jpg'
        result = await self.runtime.command('avatar', {'target': {'type': 'chat', 'id': CHAT}})
        self.assertEqual(result, 'https://cdn.example/friend.jpg')
        self.assertIn(('history', int(CHAT), 1), self.client.calls)

    async def test_avatar_group_never_uses_participant_picture(self):
        await self.connect()
        self.client.threads[0].is_group = True
        self.client.threads[0].users[1].profile_pic_url = 'https://cdn.example/friend.jpg'
        result = await self.runtime.command('avatar', {'target': {'type': 'chat', 'id': CHAT}})
        self.assertIsNone(result)

    async def test_avatar_missing_picture_returns_null(self):
        await self.connect()
        result = await self.runtime.command('avatar', {'target': {'type': 'chat', 'id': CHAT}})
        self.assertIsNone(result)

    async def test_restore_without_session_identity_is_auth_required(self):
        self.client.user_id = None
        with self.assertRaises(BridgeError) as error:
            await self.connect()
        self.assertEqual(error.exception.code, 'AUTH_REQUIRED')

    async def test_poll_orders_same_second_with_zero_microseconds(self):
        await self.connect()
        at = (datetime.now(timezone.utc) + timedelta(seconds=2)).replace(microsecond=0)
        self.client.threads = [thread([msg('fractional', at=at + timedelta(microseconds=1)), msg('whole', at=at)])]
        await self.runtime.poll_once()
        self.assertEqual([event['message']['messageId'] for event in self.events], [f'{CHAT}:whole', f'{CHAT}:fractional'])

    async def test_restored_challenge_does_not_prompt(self):

        def challenge_account():
            self.client.challenge_code_handler('me', 1)
        self.client.account_info = challenge_account
        with self.assertRaises(BridgeError) as e:
            await self.connect()
        self.assertEqual(e.exception.code, 'AUTH_REQUIRED')
        self.assertEqual(self.requests, [])

    async def test_sdk_challenge_callbacks_bounded(self):

        def challenge_login(*args, **kwargs):
            for _ in range(10):
                self.client.challenge_code_handler('me', 1)
        self.client.login = challenge_login
        with self.assertRaises(BridgeError) as e:
            await self.runtime.command('login', self.params)
        self.assertEqual(e.exception.code, 'AUTH_REQUIRED')
        self.assertEqual(len([r for r in self.requests if r.get('kind') == 'code']), 3)

    async def test_failed_login_clears_password(self):

        def fail_login(username, password):
            self.client.password = password
            raise LoginRequired('secret')
        self.client.login = fail_login
        with self.assertRaises(BridgeError):
            await self.runtime.command('login', self.params)
        self.assertIsNone(self.client.password)

@unittest.skipUnless(importlib.util.find_spec('instagrapi'), 'Instagram SDK is not installed')
class SdkMediaTests(unittest.TestCase):
    def test_broadcast_keeps_authorization_and_read_requests_keep_sdk_behavior(self):
        from instagram_runtime import create_client
        from instagrapi.exceptions import ClientRequestTimeout
        client = create_client()
        self.addCleanup(client.private.close)
        self.addCleanup(client.public.close)
        client.authorization_data = {'ds_user_id': '1', 'sessionid': 'test-session'}
        expected = {'status': 'ok', 'payload': {'item_id': MID}}
        def sent(endpoint, **kwargs):
            client.last_json = expected
        with patch.object(client, '_send_private_request', side_effect=sent) as send:
            result = client.private_request('direct_v2/threads/broadcast/text/', data={'text': 'hello'})
            self.assertEqual(result, expected)
            self.assertEqual(send.call_args.kwargs['headers']['Authorization'], client.authorization)
        with patch.object(client, '_send_private_request', side_effect=[ClientRequestTimeout('safe'), expected]) as send, \
                patch('instagrapi.mixins.private.time.sleep'):
            result = client.private_request('accounts/current_user/')
            self.assertEqual(result, expected)
            self.assertEqual(send.call_count, 2)

    def test_broadcast_writes_never_retry_timeouts_incomplete_reads_or_challenges(self):
        from instagram_runtime import create_client
        from instagrapi.exceptions import ClientIncompleteReadError, ClientRequestTimeout, ChallengeRequired
        client = create_client()
        self.addCleanup(client.private.close)
        self.addCleanup(client.public.close)
        endpoints = ['text/', 'link/', 'photo_attachment/', 'raven_attachment/?video=1', 'voice_attachment/']
        for endpoint in endpoints:
            for failure in [ClientIncompleteReadError, ClientRequestTimeout, ChallengeRequired]:
                with self.subTest(endpoint=endpoint, failure=failure.__name__), \
                        patch.object(client, '_send_private_request', side_effect=failure('safe')) as send, \
                        patch.object(client, 'challenge_resolve') as challenge, \
                        patch('instagrapi.mixins.private.time.sleep'):
                    before = client.private_requests_count
                    with self.assertRaises(failure):
                        client.private_request('direct_v2/threads/broadcast/' + endpoint, data={'text': 'hello'})
                    self.assertEqual(send.call_count, 1)
                    self.assertEqual(client.private_requests_count, before + 1)
                    challenge.assert_not_called()

    def test_restored_retry_configuration_cannot_reenable_post_retries(self):
        from instagram_runtime import create_client
        client = create_client()
        self.addCleanup(client.private.close)
        self.addCleanup(client.public.close)
        self.assertEqual(client.session_retry_total, 0)
        settings = client.get_settings()
        settings['session_retry_total'] = 3
        settings['private_transport'] = 'requests'
        client.set_settings(settings)
        self.assertEqual(settings['session_retry_total'], 3)
        self.assertEqual(client.session_retry_total, 0)
        self.assertEqual(client.get_settings()['session_retry_total'], 0)
        for adapter in client.private.adapters.values():
            self.assertEqual(adapter.max_retries.total, 0)

    def test_real_sdk_extractors_normalize_photo_video_voice_and_visual(self):
        from instagrapi.extractors import extract_direct_message
        image = {'id': '7', 'media_type': 1, 'image_versions2': {
            'candidates': [{'width': 640, 'height': 480, 'url': 'https://cdn.example/photo.jpg'}],
        }}
        video = {'id': '8', 'media_type': 2, 'video_versions': [
            {'width': 640, 'height': 480, 'url': 'https://cdn.example/video.mp4'},
        ]}
        voice = {'id': '9', 'media_type': 11, 'audio': {'audio_src': 'https://cdn.example/voice.m4a'}}
        cases = [('media', {'media': image}, 'photo'), ('media', {'media': video}, 'video'),
                 ('voice_media', {'voice_media': {'media': voice}}, 'audio'),
                 ('raven_media', {'visual_media': {'media': video, 'view_mode': 'permanent'}}, 'video')]
        for item_type, content, kind in cases:
            with self.subTest(kind=kind, item_type=item_type):
                item = extract_direct_message({'item_id': MID, 'item_type': item_type,
                    'user_id': '2', 'timestamp': int(NOW.timestamp() * 1_000_000), **content})
                attachment = normalize_message(item, CHAT, 'one', '1', {})['attachments'][0]
                self.assertEqual(attachment['kind'], kind)
                self.assertEqual(attachment['referencePayload']['messageId'], MID)
                self.assertNotIn('url', attachment)


class WorkerTests(unittest.TestCase):

    def test_worker_reads_challenge_and_session_acks_during_login(self):
        import json
        import os
        import select
        import subprocess
        import sys
        from pathlib import Path
        root = Path(__file__).resolve().parents[1]
        worker = subprocess.Popen([sys.executable, '-B', '-u', '-c', 'import asyncio; from instagram_bridge import main; from test_instagram import FakeClient; asyncio.run(main(FakeClient))'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={**os.environ, 'PYTHONPATH': os.pathsep.join([str(root), str(root / 'tests')])})

        def write(value):
            worker.stdin.write((json.dumps(value) + '\n').encode())
            worker.stdin.flush()

        def read():
            self.assertTrue(select.select([worker.stdout], [], [], 5)[0])
            return json.loads(worker.stdout.readline())
        try:
            write({'id': 1, 'method': 'login', 'params': {'accountId': 'one', 'username': 'me'}})
            challenge = read()
            self.assertEqual(challenge['kind'], 'password')
            write({'method': 'eventResult', 'requestId': challenge['requestId'], 'result': 'secret'})
            session = read()
            self.assertEqual(session['event'], 'session')
            self.assertNotIn('secret', json.dumps(session))
            self.assertFalse(select.select([worker.stdout], [], [], 0.05)[0])
            write({'method': 'eventResult', 'requestId': session['requestId'], 'result': None})
            self.assertEqual(read(), {'id': 1, 'result': {'ok': True}})
            worker.stdin.close()
            worker.wait(timeout=5)
            self.assertEqual(worker.returncode, 0)
            self.assertEqual(worker.stderr.read(), b'')
        finally:
            if worker.poll() is None:
                worker.kill()
                worker.wait(timeout=5)
            for stream in (worker.stdin, worker.stdout, worker.stderr):
                stream.close()
