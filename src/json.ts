export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const NOT_PRINTABLE_ASCII = /[^\x20-\x7e]/g;

function quote(text: string): string {
  return JSON.stringify(text).replace(
    NOT_PRINTABLE_ASCII,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * Serialize like Python's `json.dumps` with default arguments: ", " and ": " separators
 * and every character outside printable ASCII escaped as \uXXXX.
 */
export function pythonJsonDumps(value: JsonValue): string {
  if (typeof value === "string") {
    return quote(value);
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(pythonJsonDumps).join(", ")}]`;
  }
  const members = Object.entries(value).map(([key, member]) => `${quote(key)}: ${pythonJsonDumps(member)}`);
  return `{${members.join(", ")}}`;
}
