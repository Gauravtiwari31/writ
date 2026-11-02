// Fastify construction options shared by every Fastify instance the gateway code builds (app.ts, and
// the passkey spike test that mounts its plugin on a bare instance).
//
// Why: Fastify's constructor synchronously require()s its default JSON-schema compilers
// (@fastify/ajv-compiler → ajv + ajv/dist/jtd, @fastify/fast-json-stringify-compiler →
// fast-json-stringify + ajv-formats) on the first construction in a process. Profiled on Nov 1:
// ~190 ms of module loading out of a ~230 ms first buildApp() (later builds: ~10 ms). It landed in
// the first test of every test file, stretched to seconds on a loaded machine, and slowed the
// gateway's cold start. The gateway never declares a Fastify JSON `schema`: request and response
// bodies are parsed with the Zod schemas in @writ/core/api (parseWith, §22 rule 27). So these
// factories load Fastify's defaults only when a route actually declares a JSON schema, and build
// them exactly as Fastify would (lib/schema-controller.js: AjvCompiler(), SerializerSelector()).
//
// One difference if a route ever does declare `schema.headers`: Fastify treats compilers passed
// through compilersFactory as custom and then skips lowercasing header schema keys, so write header
// names in lowercase there (or, as everywhere else, parse headers with Zod).
//
// FROZEN for the parallel build (docs/ARCHITECTURE.md).
import { createRequire } from "node:module";
import type { FastifyServerOptions } from "fastify";

type SchemaController = NonNullable<FastifyServerOptions["schemaController"]>;
type CompilersFactory = NonNullable<SchemaController["compilersFactory"]>;
type ValidatorFactory = NonNullable<CompilersFactory["buildValidator"]>;
type SerializerFactory = NonNullable<CompilersFactory["buildSerializer"]>;
/** AjvCompiler()'s result, called by Fastify as (shared schemas, the server's `ajv` option). */
type BuildValidator = (externalSchemas: unknown, options?: unknown) => ReturnType<ValidatorFactory>;

// The compilers are Fastify's dependencies, not the gateway's: resolve them from Fastify's own
// install, as Fastify does.
const requireFromFastify = createRequire(createRequire(import.meta.url).resolve("fastify"));

/** Fastify's default schemaController minus the eager require; each instance gets its own lazy factories. */
export function lazySchemaController(): SchemaController {
  let validators: BuildValidator | undefined;
  let serializers: SerializerFactory | undefined;
  const buildValidator: BuildValidator = (externalSchemas, options) => {
    validators ??= (requireFromFastify("@fastify/ajv-compiler") as () => BuildValidator)();
    return validators(externalSchemas, options);
  };
  const buildSerializer: SerializerFactory = (externalSchemas, options) => {
    serializers ??= (requireFromFastify("@fastify/fast-json-stringify-compiler") as () => SerializerFactory)();
    return serializers(externalSchemas, options);
  };
  return { compilersFactory: { buildValidator: buildValidator as ValidatorFactory, buildSerializer } };
}
