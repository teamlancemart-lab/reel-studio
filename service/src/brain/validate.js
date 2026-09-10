/**
 * Schema validation over shared/schemas.json.
 *
 * Every brain node validates against its schema, retries ONCE with the error appended
 * to the prompt, then fails with a named reason. That is the whole contract: a node
 * either produces a payload that matches the shape both sides agreed on, or it dies
 * loudly. Nothing half-shaped moves downstream.
 */
import Ajv from "ajv/dist/2020.js";
import { schemas } from "../config.js";

const ajv = new Ajv({
  allErrors: true,
  strict: false, // schemas.json uses "description" on enums and other annotations
  allowUnionTypes: true,
  // schemas.json declares format: date-time. Register it rather than let ajv log
  // "unknown format ignored" on every compile.
  formats: {
    "date-time": /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?$/,
  },
});

const compiled = new Map();

/** Wrap a named top-level schema so its internal #/$defs refs resolve. */
function schemaFor(name) {
  const body = schemas[name];
  if (!body) throw new Error(`no schema named "${name}" in shared/schemas.json`);
  return {
    $schema: schemas.$schema,
    // A JSON Schema $id may not carry a fragment, so this is a path segment, not "#Name".
    $id: `${schemas.$id}/${name}`,
    ...body,
    $defs: schemas.$defs,
  };
}

export function validatorFor(name) {
  let fn = compiled.get(name);
  if (fn) return fn;
  const schema = schemaFor(name);
  try {
    fn = ajv.compile(schema);
  } catch (err) {
    /* A failed compile still registers the $id, so a second attempt would report
       "already exists" and hide the real error forever. Drop the registration and
       surface the original message. */
    try {
      ajv.removeSchema(schema.$id);
    } catch {
      /* nothing to remove */
    }
    throw new Error(`schema "${name}" does not compile: ${err.message}`);
  }
  compiled.set(name, fn);
  return fn;
}

/** Returns { ok, errors: string[] }. Errors are phrased for a model to act on. */
export function validate(name, payload) {
  const fn = validatorFor(name);
  const ok = fn(payload);
  if (ok) return { ok: true, errors: [] };
  const errors = (fn.errors || []).map((e) => {
    const where = e.instancePath || "(root)";
    if (e.keyword === "additionalProperties") {
      return `${where}: unexpected property "${e.params.additionalProperty}"`;
    }
    if (e.keyword === "required") {
      return `${where}: missing required property "${e.params.missingProperty}"`;
    }
    if (e.keyword === "enum") {
      return `${where}: ${e.message} (${JSON.stringify(e.params.allowedValues)})`;
    }
    return `${where}: ${e.message}`;
  });
  // Duplicated messages are noise in a retry prompt.
  return { ok: false, errors: [...new Set(errors)].slice(0, 20) };
}

export function assertValid(name, payload) {
  const { ok, errors } = validate(name, payload);
  if (!ok) {
    throw new Error(`${name} failed schema validation: ${errors.join("; ")}`);
  }
  return payload;
}
