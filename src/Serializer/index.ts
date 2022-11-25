import { Effect, Layer, Parser, pipe, Stream, Tag } from "tsplus-gen/common.js"
import { Symbol } from "typescript"
import { z } from "zod"

export const ExtensionKindBasic = z
  .literal("static")
  .or(z.literal("pipeable"))
  .or(z.literal("fluent"))
  .or(z.literal("getter"))
  .or(z.literal("type"))
export type ExtensionKindBasic = z.infer<typeof ExtensionKindBasic>

export const ExtensionKind = ExtensionKindBasic.or(z.literal("companion"))
  .or(z.literal("no-inherit"))
  .or(z.literal("operator"))
  .or(z.literal("pipeable-index"))
  .or(z.literal("pipeable-operator"))
  .or(z.literal("unify"))
export type ExtensionKind = z.infer<typeof ExtensionKind>

export const Extension = z.object({
  kind: ExtensionKind,
  typeName: z.string(),
  name: z.string().optional(),
})
export type Extension = z.infer<typeof Extension>

export const KindConfig = z.object({
  include: z.boolean(),
  suffix: z.string().optional(),
})
export type KindConfig = z.infer<typeof KindConfig>

export const Namespace = z.object({
  name: z.string(),
  fluent: KindConfig,
  getter: KindConfig,
  pipeable: KindConfig,
  static: KindConfig,
  type: KindConfig,
  moduleFileExtension: z.string().optional(),
})
export type Namespace = z.infer<typeof Namespace>

export const SerializerConfig = z.array(Namespace)
export type SerializerConfig = z.infer<typeof SerializerConfig>

export const DefinitionKind = z
  .literal("const")
  .or(z.literal("function"))
  .or(z.literal("interface"))
  .or(z.literal("class"))
  .or(z.literal("type"))
export type DefinitionKind = z.infer<typeof DefinitionKind>

export const Definition = z.object({
  definitionName: z.string(),
  definitionKind: DefinitionKind,
  extensions: z.array(Extension),
})
export type Definition = z.infer<typeof Definition>

type DefinitionTuple = readonly [module: string, definition: Definition]

interface ParserOutput {
  kind: DefinitionKind
  typeName: string
  module: string
  symbol: Symbol
}

const make = (namespaces: SerializerConfig) => {
  const makeDefinitions = <
    R,
    E,
    A extends ParserOutput,
    K extends ExtensionKindBasic,
  >(
    kind: K,
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
      Stream.filter(([, ns]) => ns[kind].include),
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

  const ifStatic = (a: Namespace, extension: Extension) =>
    a.static.include ? [extension] : []

  const fluents = makeDefinitions("fluent", Parser.fluents, (a, c) => [
    { kind: "fluent", typeName: a.typeName, name: a.symbol.name },
    ...ifStatic(c, {
      kind: "static",
      typeName: `${a.typeName}${c.fluent.suffix || ""}`,
      name: a.symbol.name,
    }),
  ])
  const getters = makeDefinitions("getter", Parser.getters, (a, c) => [
    { kind: "getter", typeName: a.typeName, name: a.symbol.name },
    ...ifStatic(c, {
      kind: "static",
      typeName: `${a.typeName}${c.getter.suffix || ""}`,
      name: a.symbol.name,
    }),
  ])
  const pipeables = makeDefinitions("pipeable", Parser.pipeables, (a, c) => [
    { kind: "pipeable", typeName: a.typeName, name: a.symbol.name },
    ...ifStatic(c, {
      kind: "static",
      typeName: `${a.typeName}${c.pipeable.suffix || ""}`,
      name: a.symbol.name,
    }),
  ])
  const statics = makeDefinitions("static", Parser.statics, (a, c) => [
    {
      kind: "static",
      typeName: `${a.typeName}${c.static.suffix || ""}`,
      name: a.symbol.name,
    },
  ])
  const types = makeDefinitions("type", Parser.types, (a) => [
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
