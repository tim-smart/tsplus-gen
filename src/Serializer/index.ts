import { Effect, Layer, Parser, pipe, Stream, Tag } from "tsplus-gen/common.js"
import { Symbol } from "typescript"
import { z } from "zod"

const ExtensionKindBasic = z
  .literal("static")
  .or(z.literal("pipeable"))
  .or(z.literal("fluent"))
  .or(z.literal("getter"))
  .or(z.literal("type"))
type ExtensionKindBasic = z.infer<typeof ExtensionKindBasic>

const ExtensionKind = ExtensionKindBasic.or(z.literal("companion"))
  .or(z.literal("no-inherit"))
  .or(z.literal("operator"))
  .or(z.literal("pipeable-index"))
  .or(z.literal("pipeable-operator"))
  .or(z.literal("unify"))
type ExtensionKind = z.infer<typeof ExtensionKind>

const Extension = z.object({
  kind: ExtensionKind,
  typeName: z.string(),
  name: z.string().optional(),
})
type Extension = z.infer<typeof Extension>

const KindConfig = z.object({
  include: z.boolean(),
  suffix: z.string().optional(),
})
type KindConfig = z.infer<typeof KindConfig>

const Namespace = z.object({
  name: z.string(),
  fluent: KindConfig.optional(),
  getter: KindConfig.optional(),
  pipeable: KindConfig.optional(),
  static: KindConfig.optional(),
  type: KindConfig.optional(),
  moduleFileExtension: z.string().optional(),
})
type Namespace = z.infer<typeof Namespace>

export const NamespaceList = z.array(Namespace)
export type NamespaceList = z.infer<typeof NamespaceList>

const DefinitionKind = z
  .literal("const")
  .or(z.literal("function"))
  .or(z.literal("interface"))
  .or(z.literal("class"))
  .or(z.literal("type"))
type DefinitionKind = z.infer<typeof DefinitionKind>

const Definition = z.object({
  definitionName: z.string(),
  definitionKind: DefinitionKind,
  extensions: z.array(Extension),
})
type Definition = z.infer<typeof Definition>

const ExtensionTuple = z.tuple([
  z.string().regex(/^.*#.*$/),
  ExtensionKind,
  z.string(),
])
type ExtensionTuple = z.infer<typeof ExtensionTuple>

export const AdditionalExtensions = z.array(ExtensionTuple)
export type AdditionalExtensions = z.infer<typeof AdditionalExtensions>

type DefinitionTuple = readonly [module: string, definition: Definition]

interface ParserOutput {
  kind: DefinitionKind
  typeName: string
  module: string
  symbol: Symbol
}

const make = (
  namespaces: NamespaceList,
  additionalExtensions: AdditionalExtensions = [],
) => {
  const additional = additionalExtensionsRecord(additionalExtensions)

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
      Stream.filter(([, ns]) => ns[kind]?.include ?? true),
      Stream.map(
        ([a, config]): DefinitionTuple => [
          `${a.module}${config.moduleFileExtension || ""}`,
          {
            definitionName: a.symbol.name,
            definitionKind: a.kind,
            extensions: [
              ...extensions(a, config),
              ...(additional[a.typeName]?.[a.symbol.name] ?? []),
            ],
          },
        ],
      ),
    )

  const ifStatic = (a: Namespace, extension: Extension) =>
    a.static?.include ?? true ? [extension] : []

  const fluents = makeDefinitions("fluent", Parser.fluents, (a, c) => [
    { kind: "fluent", typeName: a.typeName, name: a.symbol.name },
    ...ifStatic(c, {
      kind: "static",
      typeName: `${a.typeName}${c.fluent?.suffix || ""}`,
      name: a.symbol.name,
    }),
  ])
  const getters = makeDefinitions("getter", Parser.getters, (a, c) => [
    { kind: "getter", typeName: a.typeName, name: a.symbol.name },
    ...ifStatic(c, {
      kind: "static",
      typeName: `${a.typeName}${c.getter?.suffix || ""}`,
      name: a.symbol.name,
    }),
  ])
  const pipeables = makeDefinitions("pipeable", Parser.pipeables, (a, c) => [
    { kind: "pipeable", typeName: a.typeName, name: a.symbol.name },
    ...ifStatic(c, {
      kind: "static",
      typeName: `${a.typeName}${c.pipeable?.suffix || ""}`,
      name: a.symbol.name,
    }),
  ])
  const statics = makeDefinitions("static", Parser.statics, (a, c) => [
    {
      kind: "static",
      typeName: `${a.typeName}${c.static?.suffix || ""}`,
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

const additionalExtensionsRecord = (tuples: AdditionalExtensions) =>
  tuples
    .map(extensionFromTuple)
    .reduce<Record<string, Record<string, Extension[]>>>(
      (acc, { definitionName, extension }) => {
        if (!acc[extension.typeName]) {
          acc = {
            ...acc,
            [extension.typeName]: {},
          }
        }

        const prev = acc[extension.typeName][definitionName] ?? []

        return {
          ...acc,
          [extension.typeName]: {
            ...acc[extension.typeName],
            [definitionName]: [...prev, extension],
          },
        }
      },
      {},
    )

const extensionFromTuple = ([target, kind, name]: ExtensionTuple) => {
  const [typeName, definitionName] = target.split("#")

  const extension: Extension = {
    typeName,
    kind,
    name,
  }

  return {
    definitionName,
    extension,
  }
}

export interface Serializer extends ReturnType<typeof make> {}
export const Serializer = Tag.Tag<Serializer>()
export const makeLayer = (a: NamespaceList, b?: AdditionalExtensions) =>
  Layer.fromValue(Serializer, () => make(a, b))

export const definitions = Effect.serviceWithEffect(
  Serializer,
  (a) => a.definitions,
)
