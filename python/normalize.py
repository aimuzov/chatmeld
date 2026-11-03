from datetime import datetime, timezone


def normalize_message(message, account_id: str, own_id: int) -> dict | None:
    if message.chat_id is None or message.sender == own_id:
        return None
    chat_id = str(message.chat_id)
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
        "attachments": [{"kind": item.type} for item in message.attaches],
    }
