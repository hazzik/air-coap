#!/usr/bin/env node
import { basename } from "node:path";
import { main } from "./cli.js";

// npm installs this file under both command names; argv[1] keeps the name the user typed.
const prog = basename(process.argv[1] ?? "") === "aioairctrl" ? "aioairctrl" : "air-coap";

main(process.argv.slice(2), prog).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
