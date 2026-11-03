import { createInterface } from "node:readline";

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "hang") return;
  if (request.method === "exit") {
    process.exit(3);
  }
  if (request.method === "error") {
    console.log(JSON.stringify({ id: request.id, error: "session expired" }));
    return;
  }
  if (request.method === "event")
    console.log(JSON.stringify({ event: "message", text: "Привет" }));
  setTimeout(
    () =>
      console.log(JSON.stringify({ id: request.id, result: request.params })),
    request.params?.delay ?? 0,
  );
});
