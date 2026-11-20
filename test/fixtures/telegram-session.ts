import { StringSession } from "teleproto/sessions";

const sessionHeader = Buffer.from([2, 0, 9]);
export const savedSession =
  "1" +
  StringSession.encode(
    Buffer.concat([
      sessionHeader,
      Buffer.from("127.0.0.1"),
      Buffer.from([1, 187]),
      Buffer.alloc(256, 1),
    ]),
  );
