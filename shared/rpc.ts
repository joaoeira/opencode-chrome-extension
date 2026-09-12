import { Rpc } from "@opencode/plugin/rpc";
import { Schema } from "effect";
import { Job, Page, Reply, ReadInput, Tab } from "./contracts.ts";

// Keep validation inside the plugin's pinned Effect runtime. The 2.0.2 binary
// interprets refinement ASTs differently from the published plugin dependency.
const portable = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => ({
  "~standard": Schema.toStandardSchemaV1(schema)["~standard"],
});

const owner = { clientId: Schema.NonEmptyString };

const errors = { bridge_error: portable(Schema.Struct({ message: Schema.String })) };

export const BrowserRpc = Rpc.define({
  id: "chrome",
  events: {},
  methods: {
    read: { input: portable(ReadInput), output: portable(Page), errors },
    list: { input: portable(Schema.Struct({})), output: portable(Schema.Array(Tab)), errors },
    claim: {
      input: portable(Schema.Struct(owner)),
      errors,
      output: portable(Schema.Null),
    },
    poll: {
      input: portable(Schema.Struct(owner)),
      output: portable(Schema.Array(Job)),
      errors,
    },
    complete: {
      input: portable(Schema.Struct({ ...owner, id: Schema.String, reply: Reply })),
      output: portable(Schema.Null),
      errors,
    },
    release: { input: portable(Schema.Struct(owner)), output: portable(Schema.Null), errors },
  },
});
