from datetime import datetime, timezone
import mimetypes


def normalize_message(message, account_id: str, own_id: int) -> dict | None:
    if message.chat_id is None or message.sender == own_id:
        return None
    chat_id = str(message.chat_id)
    attachments = []
    for index, item in enumerate(message.attaches):
        kind = {"PHOTO": "photo", "VIDEO": "video", "AUDIO": "audio", "FILE": "file"}.get(item.type)
        if kind is None:
            attachments.append({"kind": item.type})
            continue
        attachment = {"kind": kind, "referencePayload": {
            "chatId": chat_id, "messageId": str(message.id), "index": index,
        }}
        if kind == "file":
            attachment["fileName"] = item.name
            attachment["size"] = item.size
            mime = mimetypes.guess_type(item.name)[0]
            if mime:
                attachment["mimeType"] = mime
        attachments.append(attachment)
    return {
        "provider": "max",
        "accountId": account_id,
        "chatId": chat_id,
        "messageId": f"{chat_id}:{message.id}",
        **({"senderId": str(message.sender)} if message.sender is not None else {}),
        "direction": "incoming",
        "text": message.text,
        "sentAt": datetime.fromtimestamp(message.time / 1000, timezone.utc)
        .isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "attachments": attachments,
    }


def normalize_read_receipt(event, account_id: str, own_id: int, is_direct: bool) -> dict | None:
    if not is_direct or event.set_as_unread or event.user_id == own_id or event.mark <= 0:
        return None
    return {
        "provider": "max", "accountId": account_id, "chatId": str(event.chat_id), "status": "read",
        "throughSentAt": datetime.fromtimestamp(event.mark / 1000, timezone.utc)
        .isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    }
