import { Schema } from "effect";
import { Settings } from "./contracts.ts";

export const nativeHostName = "ai.opencode.chrome";

export const NativeRequest = Schema.Struct({
  action: Schema.Literals(["discover", "start"]),
});

export interface NativeRequest extends Schema.Schema.Type<typeof NativeRequest> {}

export const NativeReply = Schema.TaggedUnion({
  Connected: { settings: Settings },
  Unavailable: { message: Schema.String },
});
