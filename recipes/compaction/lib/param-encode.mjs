/**
 * Adapter-side parameter encoding + runtime refusal contract.
 *
 * WHY THIS EXISTS (evidence-backed):
 * Goose 1.57.0 `goose run --recipe ... --params KEY=VALUE --render-recipe` re-serializes
 * the recipe as YAML and interpolates the parameter value VERBATIM (`{{ key }}`) into the
 * authored block scalar (`prompt: |`). The native renderer performs NO YAML escaping and
 * NO indentation repair:
 *   - A value containing a raw LF (e.g. `JSON.stringify(obj, null, 2)`) breaks the block
 *     scalar indentation -> `Error: Invalid recipe: did not find expected key` (EXIT 1).
 *   - A value containing a raw CR breaks rendering (EXIT 1).
 *   - A value containing a raw NEL (U+0085), LINE SEPARATOR (U+2028) or PARAGRAPH
 *     SEPARATOR (U+2029) breaks rendering -> `Error: Invalid recipe: could not find
 *     expected ':'` (EXIT 1). These are YAML 1.1 line-break characters; the native YAML
 *     parser treats them as line breaks even though JS `JSON.stringify` leaves them RAW.
 *   - A value that embeds an unindented `key:` line can break out of the scalar and inject
 *     recipe fields (observed: injected `extensions:`).
 *   - minijinja filters available in this build (`indent`, `replace`, `string`, …) can keep
 *     MOST multiline values inside the scalar, but are NOT fully robust: raw CR still fails,
 *     and block-scalar whitespace on blank lines is not preserved. `tojson`/`quote`/`json`/
 *     `yaml`/`escape` are NOT available (`unknown filter`). See render-probe findings.
 *
 * Therefore the supported, robust contract is: the ADAPTER (not the template) is
 * responsible for producing a value that is safe to interpolate literally. We use
 * CANONICAL SINGLE-LINE JSON: `JSON.stringify(value)` with no indentation and with EVERY
 * YAML line-break separator escaped as a two-char JSON escape — LF `\n`, CR `\r`,
 * NEL `\u0085`, LS `\u2028`, PS `\u2029` — plus TAB `\t`. A canonical single-line value
 * therefore contains no byte that can terminate or escape the YAML block scalar.
 *
 * IMPORTANT: plain `JSON.stringify` is NOT sufficient on its own. It escapes LF/CR/TAB but
 * leaves NEL/LS/PS RAW (they are valid JSON string characters), which the native YAML
 * parser still treats as line breaks. `encodeCanonicalJson` below post-processes
 * `JSON.stringify` output to escape those raw separators, closing that gap.
 *
 * The runtime refusal contract (below) makes the invariant ENFORCED rather than assumed:
 * `encodeParam` refuses any value whose serialization would still contain a raw forbidden
 * separator, and `assertInterpolatable` re-checks the final string. Callers that bypass the
 * encoder and pass a raw problematic value are refused BEFORE the recipe is rendered,
 * instead of failing opaquely inside the native YAML parser.
 */

export class ParamEncodeError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "ParamEncodeError";
    this.code = code;
  }
}

/**
 * The YAML 1.1 line-break characters, plus TAB (which also forces re-serialization of the
 * block scalar). These are the characters that must never appear RAW in a value that is
 * interpolated literally into a YAML block scalar. Named so error messages are precise.
 */
const FORBIDDEN_RAW = /[\u000A\u000D\u0085\u2028\u2029\t]/;
const SEP_NAMES = new Map([
  ["\n", "LF (U+000A)"],
  ["\r", "CR (U+000D)"],
  ["\u0085", "NEL (U+0085)"],
  ["\u2028", "LINE SEPARATOR (U+2028)"],
  ["\u2029", "PARAGRAPH SEPARATOR (U+2029)"],
  ["\t", "TAB (U+0009)"],
]);
function sepName(ch) {
  return SEP_NAMES.get(ch) || `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Canonical single-line JSON encoding.
 *
 * `JSON.stringify` escapes LF/CR/TAB but NOT NEL/LS/PS, so we post-process the JSON text
 * and replace any RAW occurrence of those separators with their JSON `\uXXXX` escape. This
 * is safe for data: inside a JSON string a raw U+0085/U+2028/U+2029 and its `\uXXXX` escape
 * decode to the SAME character, so the round-trip is preserved exactly.
 *
 * @param {unknown} value
 * @returns {string} a string with NO raw YAML line-break separator or TAB, safe for literal
 *   YAML block-scalar interpolation.
 */
export function encodeCanonicalJson(value) {
  const s = JSON.stringify(value);
  if (s === undefined) {
    throw new ParamEncodeError("unencodable_value", "value has no JSON representation");
  }
  // Escape raw NEL/LS/PS that JSON.stringify left untouched (LF/CR/TAB are already escaped).
  const escaped = s
    .replace(/\u0085/g, "\\u0085")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  if (FORBIDDEN_RAW.test(escaped)) {
    // Defensive: unreachable for valid input, since all forbidden separators are escaped above.
    const m = FORBIDDEN_RAW.exec(escaped);
    throw new ParamEncodeError(
      "raw_separator_after_encode",
      `encoder produced a raw ${sepName(m[0])} at index ${m.index}`,
    );
  }
  return escaped;
}

/**
 * Encode a parameter value for native interpolation.
 * `kind` selects the encoding policy:
 *   - "json": the value is JSON-serialized canonically (objects/arrays/strings/numbers).
 *   - "text": a free-text string is JSON-string-encoded (so it becomes a quoted JSON
 *             string literal with escaped newlines) and is therefore safe verbatim.
 * @param {unknown} value
 * @param {"json"|"text"} kind
 */
export function encodeParam(value, kind = "json") {
  if (kind === "json") return encodeCanonicalJson(value);
  if (kind === "text") {
    if (typeof value !== "string") {
      throw new ParamEncodeError("text_not_string", `expected string, got ${typeof value}`);
    }
    return encodeCanonicalJson(value); // JSON string literal, all separators escaped
  }
  throw new ParamEncodeError("bad_kind", `unknown kind ${JSON.stringify(kind)}`);
}

/**
 * Runtime refusal contract. Asserts a value is safe to interpolate literally into a
 * YAML block scalar. Throws ParamEncodeError (so the caller can refuse the run) instead
 * of allowing the native renderer to fail opaquely or, worse, to accept an injected key.
 * @param {string} s
 * @param {string} label
 */
export function assertInterpolatable(s, label = "param") {
  if (typeof s !== "string") {
    throw new ParamEncodeError("not_a_string", `${label} must be a string before interpolation`);
  }
  const m = FORBIDDEN_RAW.exec(s);
  if (m) {
    throw new ParamEncodeError(
      "multiline_refused",
      `${label} contains a raw ${sepName(m[0])} at index ${m.index}; ` +
        `adapter must supply canonical single-line JSON (JSON.stringify with no indentation ` +
        `and NEL/LS/PS escaped)`,
    );
  }
  return s;
}

/**
 * Validate that a value is canonical single-line JSON: it parses as JSON AND its canonical
 * re-serialization (which escapes NEL/LS/PS) is byte-identical. This is exactly the form
 * `encodeCanonicalJson` produces, so a value is canonical iff `encodeCanonicalJson(parse(s)) === s`.
 * @param {string} s
 */
export function isCanonicalSingleLineJson(s) {
  if (typeof s !== "string") return false;
  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch {
    return false;
  }
  try {
    return encodeCanonicalJson(parsed) === s;
  } catch {
    return false;
  }
}
