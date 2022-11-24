import { Parser } from "tsplus-gen/common.js"

export type DefinitionKind =
  | "const"
  | "function"
  | "interface"
  | "class"
  | "type"

export interface Definition {
  readonly definitionName: string
  readonly definitionKind: DefinitionKind
  readonly extensions: ReadonlyArray<Extension>
}

export type ExtensionKind = "static" | "pipeable" | "fluent" | "getter" | "type"

export interface Extension {
  readonly kind: ExtensionKind
}
