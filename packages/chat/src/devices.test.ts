import { expect, test } from "bun:test";
import { deviceName } from "./devices";

test("a device is named by its browser and system, or what is known of them", () => {
  expect(
    deviceName(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    ),
  ).toBe("Chrome on Mac");
  expect(
    deviceName(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    ),
  ).toBe("Safari on iPhone");
  expect(
    deviceName(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
    ),
  ).toBe("Edge on Windows");
  // An app's own web view names no browser: the system alone.
  expect(
    deviceName(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
    ),
  ).toBe("Mac");
  // The phone app's own requests.
  expect(deviceName("ZeroLux/1 CFNetwork/3826.500.111 Darwin/24.4.0")).toBe(
    "ZeroLux app on iOS",
  );
  expect(deviceName("okhttp/4.12.0")).toBe("ZeroLux app on Android");
  expect(deviceName(null)).toBe("Unknown device");
});
