def user_name(user):
    if user is None:
        return ""
    for name in user.names:
        full = (name.name or "").strip()
        if full:
            return full
        parts = " ".join(part.strip() for part in (name.first_name, name.last_name) if part and part.strip())
        if parts:
            return parts
    return ""


async def list_named_chats(client, chats):
    own_id = client.me.contact.id
    peers = {}
    for chat in chats:
        if chat.type != "DIALOG":
            continue
        participants = [user_id for user_id in chat.participants if user_id != own_id]
        peers[chat.id] = participants[0] if len(participants) == 1 else chat.id ^ own_id
    ids = sorted(set(peers.values()))
    users = {}
    for offset in range(0, len(ids), 100):
        for user in await client.get_users(ids[offset:offset + 100]):
            users[user.id] = user
    links = {user.id: user.link for user in users.values() if isinstance(getattr(user, "link", None), str)}
    return [{
        **({"profileUrl": links[peers[chat.id]]} if peers.get(chat.id) in links else {}),        "id": str(chat.id),
        "title": (chat.title or "").strip() or user_name(users.get(peers.get(chat.id))) or str(chat.id),
        **({"isBot": chat.has_bots} if chat.type == "DIALOG" and isinstance(getattr(chat, "has_bots", None), bool) else {}),
    } for chat in chats]
