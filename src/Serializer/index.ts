import { Effect, Layer, Parser, pipe, Stream, Tag } from "tsplus-gen/common.js"
import { Symbol } from "typescript"
import { z } from "zod"

export const Namespace = z.object({
  name: z.string(),
  fluentSuffix: z.string(),
  pipeableSuffix: z.string(),
  staticSuffix: z.string(),
  moduleFileExtension: z.string().optional(),
})
export type Namespace = z.infer<typeof Namespace>

export const SerializerConfig = z.array(Namespace)
export type SerializerConfig = z.infer<typeof SerializerConfig>

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
  module: string
  symbol: Symbol
}

const make = (namespaces: SerializerConfig) => {
  const makeDefinitions = <R, E, A extends ParserOutput>(
    self: Stream.Stream<R, E, A>,
    extensions: (a: ParserOutput, config: Namespace) => Extension[],
  ) =>
    pipe(
      self,
      Stream.map(
        (a) =>
          [
            a,
            namespaces.find((ns) => a.typeName.startsWith(ns.name))!,
          ] as const,
      ),
      Stream.filter(([, ns]) => !!ns),
      Stream.map(
        ([a, config]): DefinitionTuple => [
          `${a.module}${config.moduleFileExtension || ""}`,
          {
            definitionName: a.symbol.name,
            definitionKind: a.kind,
            extensions: extensions(a, config),
          },
        ],
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

  const definitions = pipe(
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

  return { definitions }
}

export interface Serializer extends ReturnType<typeof make> {}
export const Serializer = Tag.Tag<Serializer>()
export const makeLayer = (a: SerializerConfig) =>
  Layer.fromValue(Serializer, () => make(a))

export const definitions = Effect.serviceWithEffect(
  Serializer,
  (a) => a.definitions,
)
