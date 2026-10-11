// Independent terminal fixture: native inbox/history, no ZeroLux runner or model.
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

const [workspace, id] = process.argv.slice(2) as [string, string];
const projects = join(process.env.HOME!, ".claude/projects/terminal-fixture");
mkdirSync(projects, { recursive: true });
const history = join(projects, `${id}.jsonl`);
writeFileSync(
  history,
  JSON.stringify({
    type: "user",
    sessionId: id,
    cwd: workspace,
    message: {
      role: "user",
      content: "Remember the terminal's original conversation.",
    },
  }) + "\n",
);
mkdirSync("/tmp/cc-socks", { recursive: true, mode: 0o700 });
const socket = `/tmp/cc-socks/${process.pid}.sock`;
const server = createServer((stream) => {
  let input = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    input += chunk;
  });
  stream.on("end", () => {
    for (const line of input.trim().split("\n")) {
      const frame = JSON.parse(line);
      appendFileSync(
        history,
        JSON.stringify({
          ...frame,
          sessionId: id,
          cwd: workspace,
          origin: { kind: "peer" },
        }) + "\n",
      );
    }
  });
});
await new Promise<void>((resolve) => server.listen(socket, resolve));
chmodSync(socket, 0o600);
writeFileSync(join(workspace, "terminal-ready"), String(process.pid));
// The test kills this fixture like a closed terminal; its stale socket is deliberate.
