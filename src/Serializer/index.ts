import { Layer, Parser, pipe, Stream, Tag } from "tsplus-gen/common.js"
import { Symbol } from "typescript"

export interface SerializerConfig {
  fluentSuffix: string
  pipeableSuffix: string
  staticSuffix: string
}
export const SerializerConfig = Tag.Tag<SerializerConfig>()
export const makeConfig = (a: SerializerConfig) =>
  Layer.fromValue(SerializerConfig, () => a)

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
  readonly typeName: string
  readonly name?: string
}

type DefinitionTuple = readonly [module: string, definition: Definition]

interface ParserOutput {
  kind: DefinitionKind
  typeName: string
  namespace: string
  symbol: Symbol
}

const makeDefinitions = <R, E, A extends ParserOutput>(
  self: Stream.Stream<R, E, A>,
  extensions: (a: ParserOutput, config: SerializerConfig) => Extension[],
) =>
  Stream.serviceWithStream(SerializerConfig, (config) =>
    pipe(
      self,
      Stream.map(
        (a): DefinitionTuple => [
          a.namespace,
          {
            definitionName: a.symbol.name,
            definitionKind: a.kind,
            extensions: extensions(a, config),
          },
        ],
      ),
    ),
  )

const fluents = makeDefinitions(Parser.fluents, (a, c) => [
  { kind: "fluent", typeName: a.typeName, name: a.symbol.name },
  {
    kind: "static",
    typeName: `${a.typeName}${c.fluentSuffix}`,
    name: a.symbol.name,
  },
])
const getters = makeDefinitions(Parser.getters, (a, c) => [
  { kind: "getter", typeName: a.typeName, name: a.symbol.name },
  {
    kind: "static",
    typeName: `${a.typeName}${c.fluentSuffix}`,
    name: a.symbol.name,
  },
])
const pipeables = makeDefinitions(Parser.pipeables, (a, c) => [
  { kind: "pipeable", typeName: a.typeName, name: a.symbol.name },
  {
    kind: "static",
    typeName: `${a.typeName}${c.pipeableSuffix}`,
    name: a.symbol.name,
  },
])
const statics = makeDefinitions(Parser.statics, (a, c) => [
  {
    kind: "static",
    typeName: `${a.typeName}${c.staticSuffix}`,
    name: a.symbol.name,
  },
])
const types = makeDefinitions(Parser.types, (a) => [
  { kind: "type", typeName: a.typeName },
])

export const definitions = pipe(
  fluents,
  Stream.merge(getters),
  Stream.merge(pipeables),
  Stream.merge(statics),
  Stream.merge(types),
  Stream.runFold(
    {} as Record<string, Definition[]>,
    (acc, [namespace, definition]) => ({
      ...acc,
      [namespace]: [...(acc[namespace] || []), definition],
    }),
  ),
)
