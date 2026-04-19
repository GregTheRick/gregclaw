export type GTRRole = "system" | "user" | "model";

export type GTRComponentType =
  | "systemtext"
  | "answer"
  | "thinking"
  | "toolschema"
  | "toolcall"
  | "toolresponse"
  | "image"
  | "audio";

export interface GTRTextData {
  text: string;
}

export interface GTRTool {
  name: string;
  description: string;
  args: Array<{ name: string; arg_type: string; description: string }>;
}

export interface GTRToolSchemaData {
  tools: GTRTool[];
}

export interface GTRToolCallData {
  name: string;
  args: Array<{ key: string; val: string }>;
}

export interface GTRMultimodalData {
  multimodal: string; // base64
}

export type GTRComponentData =
  | GTRTextData
  | GTRToolSchemaData
  | GTRToolCallData
  | GTRMultimodalData;

export interface GTRChatComponent {
  ctype: GTRComponentType;
  data: GTRComponentData;
}

export interface GTRChatTurn {
  role: GTRRole;
  thinking_enabled?: boolean;
  components: GTRChatComponent[];
}

export interface GTRChatRequest {
  model: string;
  turns: GTRChatTurn[];
  stream?: boolean;
  stream_mode?: "structured" | "raw";
  options?: Record<string, unknown>;
  keep_alive?: string;
}

export type GTRChatResponseEvent =
  | { type: "thinking"; content: string }
  | { type: "text"; content: string }
  | { type: "tool_call"; tool_call: GTRToolCallData }
  | { type: "done"; status: "complete" | "call_wait" };
