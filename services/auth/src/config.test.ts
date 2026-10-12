import { expect, test } from "bun:test";
import { authOrigin } from "./config.ts";

test("configured LAN HTTP origins are supported, without accepting public HTTP or hostname lookalikes", () => {
  for (const origin of [
    "http://127.0.0.1:4310",
    "http://localhost:4310",
    "http://[::1]:4310",
    "http://192.168.1.10:4310",
    "http://10.0.0.2:4310",
    "http://172.16.0.2:4310",
    "http://172.31.255.254:4310",
    "http://169.254.1.2:4310",
    "http://[fd00::1]:4310",
    "http://[fe80::1]:4310",
    "https://company.example",
  ])
    expect(authOrigin(origin)).toBe(origin);
  for (const origin of [
    "http://company.example",
    "http://192.0.2.10:4310",
    "http://172.15.0.2:4310",
    "http://172.32.0.2:4310",
    "http://[2001:db8::1]:4310",
    "http://192.168.1.10.attacker.example",
    "http://user:password@192.168.1.10:4310",
    "http://192.168.1.10:4310/path",
    "https://*.example.test",
  ])
    expect(() => authOrigin(origin)).toThrow();
});
