import { describe, expect, it } from "vitest";
import { pythonJsonDumps } from "../src/json.js";

// Python 3 json.dumps produced each expected string from the same value.
describe("pythonJsonDumps", () => {
  it("writes a control command like json.dumps", () => {
    const command = { state: { desired: { CommandType: "app", DeviceId: "", EnduserId: "", pwr: "1", om: 2 } } };
    expect(pythonJsonDumps(command)).toBe(
      '{"state": {"desired": {"CommandType": "app", "DeviceId": "", "EnduserId": "", "pwr": "1", "om": 2}}}',
    );
  });

  it("escapes characters outside printable ASCII like json.dumps", () => {
    const value = {
      name: "Schläfzimmer ☃ 😀",
      ctl: 'a"b\\c\n\t\u0001\u007f ',
      flag: true,
      off: false,
      none: null,
      list: [1, -2, "x", []],
      empty: {},
      f: 0.5,
    };
    expect(pythonJsonDumps(value)).toBe(
      '{"name": "Schl\\u00e4fzimmer \\u2603 \\ud83d\\ude00", "ctl": "a\\"b\\\\c\\n\\t\\u0001\\u007f\\u2028", ' +
        '"flag": true, "off": false, "none": null, "list": [1, -2, "x", []], "empty": {}, "f": 0.5}',
    );
  });
});
