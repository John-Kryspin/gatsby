// @flow
const Joi = require(`@hapi/joi`)
const chalk = require(`chalk`)
const _ = require(`lodash`)
const { stripIndent } = require(`common-tags`)
const report = require(`gatsby-cli/lib/reporter`)
const path = require(`path`)
const fs = require(`fs`)
const { trueCasePathSync } = require(`true-case-path`)
const url = require(`url`)
const slash = require(`slash`)
const { hasNodeChanged, getNode } = require(`../../db/nodes`)
const { trackInlineObjectsInRootNode } = require(`../../db/node-tracking`)
const { store } = require(`..`)
const fileExistsSync = require(`fs-exists-cached`).sync
const joiSchemas = require(`../../joi-schemas/joi`)
const { generateComponentChunkName } = require(`../../utils/js-chunk-names`)
const { getCommonDir } = require(`../../utils/path`)
const apiRunnerNode = require(`../../utils/api-runner-node`)
const { trackCli } = require(`gatsby-telemetry`)

const actions = {}

const findChildrenRecursively = (children = []) => {
  children = children.concat(
    ...children.map(child => {
      const newChildren = getNode(child).children
      if (_.isArray(newChildren) && newChildren.length > 0) {
        return findChildrenRecursively(newChildren)
      } else {
        return []
      }
    })
  )

  return children
}

import type { Plugin } from "./types"

type Job = {
  id: string,
}
type PageInput = {
  path: string,
  component: string,
  context?: Object,
}

type Page = {
  path: string,
  matchPath: ?string,
  component: string,
  context: Object,
  internalComponentName: string,
  componentChunkName: string,
  updatedAt: number,
}

type ActionOptions = {
  traceId: ?string,
  parentSpan: ?Object,
  followsSpan: ?Object,
}

/**
 * Delete a page
 * @param {Object} page a page object
 * @param {string} page.path The path of the page
 * @param {string} page.component The absolute path to the page component
 * @example
 * deletePage(page)
 */
actions.deletePage = (page: PageInput) => {
  return {
    type: `DELETE_PAGE`,
    payload: page,
  }
}

const pascalCase = _.flow(
  _.camelCase,
  _.upperFirst
)
const hasWarnedForPageComponentInvalidContext = new Set()
const hasWarnedForPageComponentInvalidCasing = new Set()
const pageComponentCache = {}
const fileOkCache = {}

/**
 * Create a page. See [the guide on creating and modifying pages](/docs/creating-and-modifying-pages/)
 * for detailed documentation about creating pages.
 * @param {Object} page a page object
 * @param {string} page.path Any valid URL. Must start with a forward slash
 * @param {string} page.matchPath Path that Reach Router uses to match the page on the client side.
 * Also see docs on [matchPath](/docs/gatsby-internals-terminology/#matchpath)
 * @param {string} page.component The absolute path to the component for this page
 * @param {Object} page.context Context data for this page. Passed as props
 * to the component `this.props.pageContext` as well as to the graphql query
 * as graphql arguments.
 * @example
 * createPage({
 *   path: `/my-sweet-new-page/`,
 *   component: path.resolve(`./src/templates/my-sweet-new-page.js`),
 *   // The context is passed as props to the component as well
 *   // as into the component's GraphQL query.
 *   context: {
 *     id: `123456`,
 *   },
 * })
 */
actions.createPage = (
  page: PageInput,
  plugin?: Plugin,
  actionOptions?: ActionOptions
) => {
  let name = `The plugin "${plugin.name}"`
  if (plugin.name === `default-site-plugin`) {
    name = `Your site's "gatsby-node.js"`
  }
  if (!page.path) {
    const message = `${name} must set the page path when creating a page`
    // Don't log out when testing
    if (process.env.NODE_ENV !== `test`) {
      report.panic({
        id: `11323`,
        context: {
          pluginName: name,
          pageObject: page,
          message,
        },
      })
    } else {
      return message
    }
  }

  // Validate that the context object doesn't overlap with any core page fields
  // as this will cause trouble when running graphql queries.
  if (_.isObject(page.context)) {
    const reservedFields = [
      `path`,
      `matchPath`,
      `component`,
      `componentChunkName`,
      `pluginCreator___NODE`,
      `pluginCreatorId`,
    ]
    const invalidFields = Object.keys(_.pick(page.context, reservedFields))

    const singularMessage = `${name} used a reserved field name in the context object when creating a page:`
    const pluralMessage = `${name} used reserved field names in the context object when creating a page:`
    if (invalidFields.length > 0) {
      const error = `${
        invalidFields.length === 1 ? singularMessage : pluralMessage
      }

${invalidFields.map(f => `  * "${f}"`).join(`\n`)}

${JSON.stringify(page, null, 4)}

Data in "context" is passed to GraphQL as potential arguments when running the
page query.

When arguments for GraphQL are constructed, the context object is combined with
the page object so *both* page object and context data are available as
arguments. So you don't need to add the page "path" to the context as it's
already available in GraphQL. If a context field duplicates a field already
used by the page object, this can break functionality within Gatsby so must be
avoided.

Please choose another name for the conflicting fields.

The following fields are used by the page object and should be avoided.

${reservedFields.map(f => `  * "${f}"`).join(`\n`)}

            `
      if (process.env.NODE_ENV === `test`) {
        return error
        // Only error if the context version is different than the page
        // version.  People in v1 often thought that they needed to also pass
        // the path to context for it to be available in GraphQL
      } else if (invalidFields.some(f => page.context[f] !== page[f])) {
        report.panic({
          id: `11324`,
          context: {
            message: error,
          },
        })
      } else {
        if (!hasWarnedForPageComponentInvalidContext.has(page.component)) {
          report.warn(error)
          hasWarnedForPageComponentInvalidContext.add(page.component)
        }
      }
    }
  }

  // Check if a component is set.
  if (!page.component) {
    if (process.env.NODE_ENV !== `test`) {
      report.panic({
        id: `11322`,
        context: {
          pluginName: name,
          pageObject: page,
        },
      })
    } else {
      // For test
      return `A component must be set when creating a page`
    }
  }

  // Don't check if the component exists during tests as we use a lot of fake
  // component paths.
  if (process.env.NODE_ENV !== `test`) {
    if (!fileExistsSync(page.component)) {
      report.panic({
        id: `11325`,
        context: {
          pluginName: name,
          pageObject: page,
          component: page.component,
        },
      })
    }
  }
  if (!path.isAbsolute(page.component)) {
    // Don't log out when testing
    if (process.env.NODE_ENV !== `test`) {
      report.panic({
        id: `11326`,
        context: {
          pluginName: name,
          pageObject: page,
          component: page.component,
        },
      })
    } else {
      const message = `${name} must set the absolute path to the page component when create creating a page`
      return message
    }
  }

  // check if we've processed this component path
  // before, before running the expensive "trueCasePath"
  // operation
  //
  // Skip during testing as the paths don't exist on disk.
  if (process.env.NODE_ENV !== `test`) {
    if (pageComponentCache[page.component]) {
      page.component = pageComponentCache[page.component]
    } else {
      const originalPageComponent = page.component

      // normalize component path
      page.component = slash(page.component)
      // check if path uses correct casing - incorrect casing will
      // cause issues in query compiler and inconsistencies when
      // developing on Mac or Windows and trying to deploy from
      // linux CI/CD pipeline
      let trueComponentPath
      try {
        // most systems
        trueComponentPath = slash(trueCasePathSync(page.component))
      } catch (e) {
        // systems where user doesn't have access to /
        const commonDir = getCommonDir(
          store.getState().program.directory,
          page.component
        )

        // using `path.win32` to force case insensitive relative path
        const relativePath = slash(
          path.win32.relative(commonDir, page.component)
        )

        trueComponentPath = slash(trueCasePathSync(relativePath, commonDir))
      }

      if (trueComponentPath !== page.component) {
        if (!hasWarnedForPageComponentInvalidCasing.has(page.component)) {
          const markers = page.component
            .split(``)
            .map((letter, index) => {
              if (letter !== trueComponentPath[index]) {
                return `^`
              }
              return ` `
            })
            .join(``)

          report.warn(
            stripIndent`
          ${name} created a page with a component path that doesn't match the casing of the actual file. This may work locally, but will break on systems which are case-sensitive, e.g. most CI/CD pipelines.

          page.component:     "${page.component}"
          path in filesystem: "${trueComponentPath}"
                               ${markers}
        `
          )
          hasWarnedForPageComponentInvalidCasing.add(page.component)
        }

        page.component = trueComponentPath
      }

      pageComponentCache[originalPageComponent] = page.component
    }
  }

  let internalComponentName
  if (page.path === `/`) {
    internalComponentName = `ComponentIndex`
  } else {
    internalComponentName = `Component${pascalCase(page.path)}`
  }

  let internalPage: Page = {
    internalComponentName,
    path: page.path,
    matchPath: page.matchPath,
    component: page.component,
    componentChunkName: generateComponentChunkName(page.component),
    isCreatedByStatefulCreatePages:
      actionOptions &&
      actionOptions.traceId === `initial-createPagesStatefully`,
    // Ensure the page has a context object
    context: page.context || {},
    updatedAt: Date.now(),
  }

  // If the path doesn't have an initial forward slash, add it.
  if (internalPage.path[0] !== `/`) {
    internalPage.path = `/${internalPage.path}`
  }

  // Validate that the page component imports React and exports something
  // (hopefully a component).
  //
  // Only run validation once during builds.
  if (
    !internalPage.component.includes(`/.cache/`) &&
    (process.env.NODE_ENV === `production` &&
      !fileOkCache[internalPage.component])
  ) {
    const fileName = internalPage.component
    const fileContent = fs.readFileSync(fileName, `utf-8`)
    let notEmpty = true
    let includesDefaultExport = true

    if (fileContent === ``) {
      notEmpty = false
    }

    if (
      !fileContent.includes(`export default`) &&
      !fileContent.includes(`module.exports`) &&
      !fileContent.includes(`exports.default`) &&
      // this check only applies to js and ts, not mdx
      /\.(jsx?|tsx?)/.test(path.extname(fileName))
    ) {
      includesDefaultExport = false
    }
    if (!notEmpty || !includesDefaultExport) {
      const relativePath = path.relative(
        store.getState().program.directory,
        fileName
      )

      if (!notEmpty) {
        report.panicOnBuild({
          id: `11327`,
          context: {
            relativePath,
          },
        })
      }

      if (!includesDefaultExport) {
        report.panicOnBuild({
          id: `11328`,
          context: {
            fileName,
          },
        })
      }
    }

    fileOkCache[internalPage.component] = true
  }

  const oldPage: Page = store.getState().pages.get(internalPage.path)
  const contextModified =
    !!oldPage && !_.isEqual(oldPage.context, internalPage.context)

  const alternateSlashPath = page.path.endsWith(`/`)
    ? page.path.slice(0, -1)
    : page.path + `/`

  if (store.getState().pages.has(alternateSlashPath)) {
    report.warn(
      `Attempting to create page "${page.path}", but page "${alternateSlashPath}" already exists. This could lead to non-deterministic routing behavior`
    )
  }

  return {
    ...actionOptions,
    type: `CREATE_PAGE`,
    contextModified,
    plugin,
    payload: internalPage,
  }
}

/**
 * Delete a node
 * @param {object} $0
 * @param {object} $0.node the node object
 * @example
 * deleteNode({node: node})
 */
actions.deleteNode = (options: any, plugin: Plugin, args: any) => {
  let id

  // Check if using old method signature. Warn about incorrect usage but get
  // node from nodeID anyway.
  if (typeof options === `string`) {
    let msg =
      `Calling "deleteNode" with a nodeId is deprecated. Please pass an ` +
      `object containing a full node instead: deleteNode({ node }).`
    if (args && args.name) {
      // `plugin` used to be the third argument
      plugin = args
      msg = msg + ` "deleteNode" was called by ${plugin.name}`
    }
    report.warn(msg)

    id = options
  } else {
    id = options && options.node && options.node.id
  }

  // Always get node from the store, as the node we get as an arg
  // might already have been deleted.
  const node = getNode(id)
  if (plugin) {
    const pluginName = plugin.name

    if (node && typeOwners[node.internal.type] !== pluginName)
      throw new Error(stripIndent`
          The plugin "${pluginName}" deleted a node of a type owned by another plugin.

          The node type "${node.internal.type}" is owned by "${
        typeOwners[node.internal.type]
      }".

          The node object passed to "deleteNode":

          ${JSON.stringify(node, null, 4)}

          The plugin deleting the node:

          ${JSON.stringify(plugin, null, 4)}
        `)
  }

  const createDeleteAction = node => {
    return {
      type: `DELETE_NODE`,
      plugin,
      payload: node,
    }
  }

  const deleteAction = createDeleteAction(node)

  // It's possible the file node was never created as sometimes tools will
  // write and then immediately delete temporary files to the file system.
  const deleteDescendantsActions =
    node &&
    findChildrenRecursively(node.children)
      .map(getNode)
      .map(createDeleteAction)

  if (deleteDescendantsActions && deleteDescendantsActions.length) {
    return [...deleteDescendantsActions, deleteAction]
  } else {
    return deleteAction
  }
}

/**
 * Batch delete nodes
 * @param {Array} nodes an array of node ids
 * @example
 * deleteNodes([`node1`, `node2`])
 */
actions.deleteNodes = (nodes: any[], plugin: Plugin) => {
  let msg =
    `The "deleteNodes" action is now deprecated and will be removed in ` +
    `Gatsby v3. Please use "deleteNode" instead.`
  if (plugin && plugin.name) {
    msg = msg + ` "deleteNodes" was called by ${plugin.name}`
  }
  report.warn(msg)

  // Also delete any nodes transformed from these.
  const descendantNodes = _.flatten(
    nodes.map(n => findChildrenRecursively(getNode(n).children))
  )

  const deleteNodesAction = {
    type: `DELETE_NODES`,
    plugin,
    payload: [...nodes, ...descendantNodes],
  }
  return deleteNodesAction
}

const typeOwners = {}
/**
 * Create a new node.
 * @param {Object} node a node object
 * @param {string} node.id The node's ID. Must be globally unique.
 * @param {string} node.parent The ID of the parent's node. If the node is
 * derived from another node, set that node as the parent. Otherwise it can
 * just be `null`.
 * @param {Array} node.children An array of children node IDs. If you're
 * creating the children nodes while creating the parent node, add the
 * children node IDs here directly. If you're adding a child node to a
 * parent node created by a plugin, you can't mutate this value directly
 * to add your node id, instead use the action creator `createParentChildLink`.
 * @param {Object} node.internal node fields that aren't generally
 * interesting to consumers of node data but are very useful for plugin writers
 * and Gatsby core.
 * @param {string} node.internal.mediaType An optional field to indicate to
 * transformer plugins that your node has raw content they can transform.
 * Use either an official media type (we use mime-db as our source
 * (https://www.npmjs.com/package/mime-db) or a made-up one if your data
 * doesn't fit in any existing bucket. Transformer plugins use node media types
 * for deciding if they should transform a node into a new one. E.g.
 * markdown transformers look for media types of
 * `text/markdown`.
 * @param {string} node.internal.type An arbitrary globally unique type
 * chosen by the plugin creating the node. Should be descriptive of the
 * node as the type is used in forming GraphQL types so users will query
 * for nodes based on the type chosen here. Nodes of a given type can
 * only be created by one plugin.
 * @param {string} node.internal.content An optional field. This is rarely
 * used. It is used when a source plugin sources data it doesn't know how
 * to transform e.g. a markdown string pulled from an API. The source plugin
 * can defer the transformation to a specialized transformer plugin like
 * gatsby-transformer-remark. This `content` field holds the raw content
 * (so for the markdown case, the markdown string).
 *
 * Data that's already structured should be added to the top-level of the node
 * object and _not_ added here. You should not `JSON.stringify` your node's
 * data here.
 *
 * If the content is very large and can be lazy-loaded, e.g. a file on disk,
 * you can define a `loadNodeContent` function for this node and the node
 * content will be lazy loaded when it's needed.
 * @param {string} node.internal.contentDigest the digest for the content
 * of this node. Helps Gatsby avoid doing extra work on data that hasn't
 * changed.
 * @param {string} node.internal.description An optional field. Human
 * readable description of what this node represent / its source. It will
 * be displayed when type conflicts are found, making it easier to find
 * and correct type conflicts.
 * @returns {Promise} The returned Promise resolves when all cascading
 * `onCreateNode` API calls triggered by `createNode` have finished.
 * @example
 * createNode({
 *   // Data for the node.
 *   field1: `a string`,
 *   field2: 10,
 *   field3: true,
 *   ...arbitraryOtherData,
 *
 *   // Required fields.
 *   id: `a-node-id`,
 *   parent: `the-id-of-the-parent-node`, // or null if it's a source node without a parent
 *   children: [],
 *   internal: {
 *     type: `CoolServiceMarkdownField`,
 *     contentDigest: crypto
 *       .createHash(`md5`)
 *       .update(JSON.stringify(fieldData))
 *       .digest(`hex`),
 *     mediaType: `text/markdown`, // optional
 *     content: JSON.stringify(fieldData), // optional
 *     description: `Cool Service: "Title of entry"`, // optional
 *   }
 * })
 */
const createNode = (
  node: any,
  plugin?: Plugin,
  actionOptions?: ActionOptions = {}
) => {
  if (!_.isObject(node)) {
    return console.log(
      chalk.bold.red(
        `The node passed to the "createNode" action creator must be an object`
      )
    )
  }

  // Ensure the new node has an internals object.
  if (!node.internal) {
    node.internal = {}
  }

  // Ensure the new node has a children array.
  if (!node.array && !_.isArray(node.children)) {
    node.children = []
  }

  // Ensure the new node has a parent field
  if (!node.parent) {
    node.parent = null
  }

  // Tell user not to set the owner name themself.
  if (node.internal.owner) {
    report.error(JSON.stringify(node, null, 4))
    report.panic(
      chalk.bold.red(
        `The node internal.owner field is set automatically by Gatsby and not by plugins`
      )
    )
  }

  const trackParams = {}
  // Add the plugin name to the internal object.
  if (plugin) {
    node.internal.owner = plugin.name
    trackParams[`pluginName`] = `${plugin.name}@${plugin.version}`
  }

  trackCli(`CREATE_NODE`, trackParams, { debounce: true })

  const result = Joi.validate(node, joiSchemas.nodeSchema)
  if (result.error) {
    console.log(chalk.bold.red(`The new node didn't pass validation`))
    console.log(chalk.bold.red(result.error))
    console.log(node)
    return { type: `VALIDATION_ERROR`, error: true }
  }

  // Ensure node isn't directly setting fields.
  if (node.fields) {
    throw new Error(
      stripIndent`
      Plugins creating nodes can not set data on the reserved field "fields"
      as this is reserved for plugins which wish to extend your nodes.

      If your plugin didn't add "fields" you're probably seeing this
      error because you're reusing an old node object.

      Node:

      ${JSON.stringify(node, null, 4)}

      Plugin that created the node:

      ${JSON.stringify(plugin, null, 4)}
    `
    )
  }

  node = trackInlineObjectsInRootNode(node, true)

  const oldNode = getNode(node.id)

  // Ensure the plugin isn't creating a node type owned by another
  // plugin. Type "ownership" is first come first served.
  if (plugin) {
    let pluginName = plugin.name

    if (!typeOwners[node.internal.type])
      typeOwners[node.internal.type] = pluginName
    else if (typeOwners[node.internal.type] !== pluginName)
      throw new Error(stripIndent`
        The plugin "${pluginName}" created a node of a type owned by another plugin.

        The node type "${node.internal.type}" is owned by "${
        typeOwners[node.internal.type]
      }".

        If you copy and pasted code from elsewhere, you'll need to pick a new type name
        for your new node(s).

        The node object passed to "createNode":

        ${JSON.stringify(node, null, 4)}

        The plugin creating the node:

        ${JSON.stringify(plugin, null, 4)}
      `)

    // If the node has been created in the past, check that
    // the current plugin is the same as the previous.
    if (oldNode && oldNode.internal.owner !== pluginName) {
      throw new Error(
        stripIndent`
        Nodes can only be updated by their owner. Node "${node.id}" is
        owned by "${oldNode.internal.owner}" and another plugin "${pluginName}"
        tried to update it.

        `
      )
    }
  }

  if (actionOptions.parentSpan) {
    actionOptions.parentSpan.setTag(`nodeId`, node.id)
    actionOptions.parentSpan.setTag(`nodeType`, node.id)
  }

  let deleteActions
  let updateNodeAction
  // Check if the node has already been processed.
  if (oldNode && !hasNodeChanged(node.id, node.internal.contentDigest)) {
    updateNodeAction = {
      type: `TOUCH_NODE`,
      plugin,
      ...actionOptions,
      payload: node.id,
    }
  } else {
    // Remove any previously created descendant nodes as they're all due
    // to be recreated.
    if (oldNode) {
      const createDeleteAction = node => {
        return {
          type: `DELETE_NODE`,
          plugin,
          ...actionOptions,
          payload: node,
        }
      }
      deleteActions = findChildrenRecursively(oldNode.children)
        .map(getNode)
        .map(createDeleteAction)
    }

    updateNodeAction = {
      type: `CREATE_NODE`,
      plugin,
      oldNode,
      ...actionOptions,
      payload: node,
    }
  }

  if (deleteActions && deleteActions.length) {
    return [...deleteActions, updateNodeAction]
  } else {
    return updateNodeAction
  }
}

actions.createNode = (...args) => dispatch => {
  const actions = createNode(...args)
  dispatch(actions)
  const createNodeAction = (Array.isArray(actions) ? actions : [actions]).find(
    action => action.type === `CREATE_NODE`
  )

  if (!createNodeAction) {
    return undefined
  }

  const { payload: node, traceId, parentSpan } = createNodeAction
  return apiRunnerNode(`onCreateNode`, {
    node,
    traceId,
    parentSpan,
    traceTags: { nodeId: node.id, nodeType: node.internal.type },
  })
}

/**
 * "Touch" a node. Tells Gatsby a node still exists and shouldn't
 * be garbage collected. Primarily useful for source plugins fetching
 * nodes from a remote system that can return only nodes that have
 * updated. The source plugin then touches all the nodes that haven't
 * updated but still exist so Gatsby knows to keep them.
 * @param {Object} $0
 * @param {string} $0.nodeId The id of a node
 * @example
 * touchNode({ nodeId: `a-node-id` })
 */
actions.touchNode = (options: any, plugin?: Plugin) => {
  let nodeId = _.get(options, `nodeId`)

  // Check if using old method signature. Warn about incorrect usage
  if (typeof options === `string`) {
    console.warn(
      `Calling "touchNode" with a nodeId is deprecated. Please pass an object containing a nodeId instead: touchNode({ nodeId: 'a-node-id' })`
    )

    if (plugin && plugin.name) {
      console.log(`"touchNode" was called by ${plugin.name}`)
    }

    nodeId = options
  }

  const node = getNode(nodeId)
  if (node && !typeOwners[node.internal.type]) {
    typeOwners[node.internal.type] = node.internal.owner
  }

  return {
    type: `TOUCH_NODE`,
    plugin,
    payload: nodeId,
  }
}

type CreateNodeInput = {
  node: Object,
  fieldName?: string,
  fieldValue?: string,
  name?: string,
  value: any,
}
/**
 * Extend another node. The new node field is placed under the `fields`
 * key on the extended node object.
 *
 * Once a plugin has claimed a field name the field name can't be used by
 * other plugins.  Also since nodes are immutable, you can't mutate the node
 * directly. So to extend another node, use this.
 * @param {Object} $0
 * @param {Object} $0.node the target node object
 * @param {string} $0.fieldName [deprecated] the name for the field
 * @param {string} $0.fieldValue [deprecated] the value for the field
 * @param {string} $0.name the name for the field
 * @param {string} $0.value the value for the field
 * @example
 * createNodeField({
 *   node,
 *   name: `happiness`,
 *   value: `is sweet graphql queries`
 * })
 *
 * // The field value is now accessible at node.fields.happiness
 */
actions.createNodeField = (
  { node, name, value, fieldName, fieldValue }: CreateNodeInput,
  plugin: Plugin,
  actionOptions?: ActionOptions
) => {
  if (fieldName) {
    console.warn(
      `Calling "createNodeField" with "fieldName" is deprecated. Use "name" instead`
    )
    if (!name) {
      name = fieldName
    }
  }
  if (fieldValue) {
    console.warn(
      `Calling "createNodeField" with "fieldValue" is deprecated. Use "value" instead`
    )
    if (!value) {
      value = fieldValue
    }
  }
  // Ensure required fields are set.
  if (!node.internal.fieldOwners) {
    node.internal.fieldOwners = {}
  }
  if (!node.fields) {
    node.fields = {}
  }

  // Normalized name of the field that will be used in schema
  const schemaFieldName = _.includes(name, `___NODE`)
    ? name.split(`___`)[0]
    : name

  // Check that this field isn't owned by another plugin.
  const fieldOwner = node.internal.fieldOwners[schemaFieldName]
  if (fieldOwner && fieldOwner !== plugin.name) {
    throw new Error(
      stripIndent`
      A plugin tried to update a node field that it doesn't own:

      Node id: ${node.id}
      Plugin: ${plugin.name}
      name: ${name}
      value: ${value}
      `
    )
  }

  // Update node
  node.fields[name] = value
  node.internal.fieldOwners[schemaFieldName] = plugin.name
  node = trackInlineObjectsInRootNode(node, true)

  return {
    type: `ADD_FIELD_TO_NODE`,
    plugin,
    ...actionOptions,
    payload: node,
  }
}

/**
 * Creates a link between a parent and child node. This is used when you
 * transform content from a node creating a new child node. You need to add
 * this new child node to the `children` array of the parent but since you
 * don't have direct access to the immutable parent node, use this action
 * instead.
 * @param {Object} $0
 * @param {Object} $0.parent the parent node object
 * @param {Object} $0.child the child node object
 * @example
 * createParentChildLink({ parent: parentNode, child: childNode })
 */
actions.createParentChildLink = (
  { parent, child }: { parent: any, child: any },
  plugin?: Plugin
) => {
  // Update parent
  parent.children.push(child.id)
  parent.children = _.uniq(parent.children)

  return {
    type: `ADD_CHILD_NODE_TO_PARENT_NODE`,
    plugin,
    payload: parent,
  }
}

/**
 * Merge additional configuration into the current webpack config. A few
 * configurations options will be ignored if set, in order to try prevent accidental breakage.
 * Specifically, any change to `entry`, `output`, `target`, or `resolveLoaders` will be ignored.
 *
 * For full control over the webpack config, use `replaceWebpackConfig()`.
 *
 * @param {Object} config partial webpack config, to be merged into the current one
 */
actions.setWebpackConfig = (config: Object, plugin?: ?Plugin = null) => {
  return {
    type: `SET_WEBPACK_CONFIG`,
    plugin,
    payload: config,
  }
}

/**
 * Completely replace the webpack config for the current stage. This can be
 * dangerous and break Gatsby if certain configuration options are changed.
 *
 * Generally only useful for cases where you need to handle config merging logic
 * yourself, in which case consider using `webpack-merge`.
 *
 * @param {Object} config complete webpack config
 */
actions.replaceWebpackConfig = (config: Object, plugin?: ?Plugin = null) => {
  return {
    type: `REPLACE_WEBPACK_CONFIG`,
    plugin,
    payload: config,
  }
}

/**
 * Set top-level Babel options. Plugins and presets will be ignored. Use
 * setBabelPlugin and setBabelPreset for this.
 * @param {Object} config An options object in the shape of a normal babelrc JavaScript object
 * @example
 * setBabelOptions({
 *   options: {
 *     sourceMaps: `inline`,
 *   }
 * })
 */
actions.setBabelOptions = (options: Object, plugin?: ?Plugin = null) => {
  // Validate
  let name = `The plugin "${plugin.name}"`
  if (plugin.name === `default-site-plugin`) {
    name = `Your site's "gatsby-node.js"`
  }
  if (!_.isObject(options)) {
    console.log(`${name} must pass an object to "setBabelOptions"`)
    console.log(JSON.stringify(options, null, 4))
    if (process.env.NODE_ENV !== `test`) {
      process.exit(1)
    }
  }

  if (!_.isObject(options.options)) {
    console.log(`${name} must pass options to "setBabelOptions"`)
    console.log(JSON.stringify(options, null, 4))
    if (process.env.NODE_ENV !== `test`) {
      process.exit(1)
    }
  }

  return {
    type: `SET_BABEL_OPTIONS`,
    plugin,
    payload: options,
  }
}

/**
 * Add new plugins or merge options into existing Babel plugins.
 * @param {Object} config A config object describing the Babel plugin to be added.
 * @param {string} config.name The name of the Babel plugin
 * @param {Object} config.options Options to pass to the Babel plugin.
 * @example
 * setBabelPlugin({
 *   name:  `babel-plugin-emotion`,
 *   options: {
 *     sourceMap: true,
 *   },
 * })
 */
actions.setBabelPlugin = (config: Object, plugin?: ?Plugin = null) => {
  // Validate
  let name = `The plugin "${plugin.name}"`
  if (plugin.name === `default-site-plugin`) {
    name = `Your site's "gatsby-node.js"`
  }
  if (!config.name) {
    console.log(`${name} must set the name of the Babel plugin`)
    console.log(JSON.stringify(config, null, 4))
    if (process.env.NODE_ENV !== `test`) {
      process.exit(1)
    }
  }
  if (!config.options) {
    config.options = {}
  }
  return {
    type: `SET_BABEL_PLUGIN`,
    plugin,
    payload: config,
  }
}

/**
 * Add new presets or merge options into existing Babel presets.
 * @param {Object} config A config object describing the Babel plugin to be added.
 * @param {string} config.name The name of the Babel preset.
 * @param {Object} config.options Options to pass to the Babel preset.
 * @example
 * setBabelPreset({
 *   name: `@babel/preset-react`,
 *   options: {
 *     pragma: `Glamor.createElement`,
 *   },
 * })
 */
actions.setBabelPreset = (config: Object, plugin?: ?Plugin = null) => {
  // Validate
  let name = `The plugin "${plugin.name}"`
  if (plugin.name === `default-site-plugin`) {
    name = `Your site's "gatsby-node.js"`
  }
  if (!config.name) {
    console.log(`${name} must set the name of the Babel preset`)
    console.log(JSON.stringify(config, null, 4))
    if (process.env.NODE_ENV !== `test`) {
      process.exit(1)
    }
  }
  if (!config.options) {
    config.options = {}
  }
  return {
    type: `SET_BABEL_PRESET`,
    plugin,
    payload: config,
  }
}

/**
 * Create a "job". This is a long-running process that are generally
 * started as side-effects to GraphQL queries.
 * [`gatsby-plugin-sharp`](/packages/gatsby-plugin-sharp/) uses this for
 * example.
 *
 * Gatsby doesn't finish its bootstrap until all jobs are ended.
 * @param {Object} job A job object with at least an id set
 * @param {id} job.id The id of the job
 * @example
 * createJob({ id: `write file id: 123`, fileName: `something.jpeg` })
 */
actions.createJob = (job: Job, plugin?: ?Plugin = null) => {
  return {
    type: `CREATE_JOB`,
    plugin,
    payload: job,
  }
}

/**
 * Set (update) a "job". Sometimes on really long running jobs you want
 * to update the job as it continues.
 *
 * @param {Object} job A job object with at least an id set
 * @param {id} job.id The id of the job
 * @example
 * setJob({ id: `write file id: 123`, progress: 50 })
 */
actions.setJob = (job: Job, plugin?: ?Plugin = null) => {
  return {
    type: `SET_JOB`,
    plugin,
    payload: job,
  }
}

/**
 * End a "job".
 *
 * Gatsby doesn't finish its bootstrap until all jobs are ended.
 * @param {Object} job  A job object with at least an id set
 * @param {id} job.id The id of the job
 * @example
 * endJob({ id: `write file id: 123` })
 */
actions.endJob = (job: Job, plugin?: ?Plugin = null) => {
  return {
    type: `END_JOB`,
    plugin,
    payload: job,
  }
}

/**
 * Set plugin status. A plugin can use this to save status keys e.g. the last
 * it fetched something. These values are persisted between runs of Gatsby.
 *
 * @param {Object} status  An object with arbitrary values set
 * @example
 * setPluginStatus({ lastFetched: Date.now() })
 */
actions.setPluginStatus = (
  status: { [key: string]: mixed },
  plugin: Plugin
) => {
  return {
    type: `SET_PLUGIN_STATUS`,
    plugin,
    payload: status,
  }
}

// Check if path is absolute and add pathPrefix in front if it's not
const maybeAddPathPrefix = (path, pathPrefix) => {
  const parsed = url.parse(path)
  const isRelativeProtocol = path.startsWith(`//`)
  return `${
    parsed.protocol != null || isRelativeProtocol ? `` : pathPrefix
  }${path}`
}

/**
 * Create a redirect from one page to another. Server redirects don't work out
 * of the box. You must have a plugin setup to integrate the redirect data with
 * your hosting technology e.g. the [Netlify
 * plugin](/packages/gatsby-plugin-netlify/), or the [Amazon S3
 * plugin](/packages/gatsby-plugin-s3/).
 *
 * @param {Object} redirect Redirect data
 * @param {string} redirect.fromPath Any valid URL. Must start with a forward slash
 * @param {boolean} redirect.isPermanent This is a permanent redirect; defaults to temporary
 * @param {string} redirect.toPath URL of a created page (see `createPage`)
 * @param {boolean} redirect.redirectInBrowser Redirects are generally for redirecting legacy URLs to their new configuration. If you can't update your UI for some reason, set `redirectInBrowser` to true and Gatsby will handle redirecting in the client as well.
 * @param {boolean} redirect.force (Plugin-specific) Will trigger the redirect even if the `fromPath` matches a piece of content. This is not part of the Gatsby API, but implemented by (some) plugins that configure hosting provider redirects
 * @param {number} redirect.statusCode (Plugin-specific) Manually set the HTTP status code. This allows you to create a rewrite (status code 200) or custom error page (status code 404). Note that this will override the `isPermanent` option which also sets the status code. This is not part of the Gatsby API, but implemented by (some) plugins that configure hosting provider redirects
 * @example
 * // Generally you create redirects while creating pages.
 * exports.createPages = ({ graphql, actions }) => {
 *   const { createRedirect } = actions
 *   createRedirect({ fromPath: '/old-url', toPath: '/new-url', isPermanent: true })
 *   createRedirect({ fromPath: '/url', toPath: '/zn-CH/url', Language: 'zn' })
 *   createRedirect({ fromPath: '/not_so-pretty_url', toPath: '/pretty/url', statusCode: 200 })
 *   // Create pages here
 * }
 */
actions.createRedirect = ({
  fromPath,
  isPermanent = false,
  redirectInBrowser = false,
  toPath,
  ...rest
}) => {
  let pathPrefix = ``
  if (store.getState().program.prefixPaths) {
    pathPrefix = store.getState().config.pathPrefix
  }

  return {
    type: `CREATE_REDIRECT`,
    payload: {
      fromPath: maybeAddPathPrefix(fromPath, pathPrefix),
      isPermanent,
      redirectInBrowser,
      toPath: maybeAddPathPrefix(toPath, pathPrefix),
      ...rest,
    },
  }
}

/**
 * Create a dependency between a page and data.
 *
 * @param {Object} $0
 * @param {string} $0.path the path to the page
 * @param {string} $0.nodeId A node ID
 * @param {string} $0.connection A connection type
 * @private
 */
actions.createPageDependency = (
  {
    path,
    nodeId,
    connection,
  }: { path: string, nodeId: string, connection: string },
  plugin: string = ``
) => {
  console.warn(
    `Calling "createPageDependency" directly from actions in deprecated. Use "createPageDependency" from "gatsby/dist/redux/actions/add-page-dependency".`
  )
  return {
    type: `CREATE_COMPONENT_DEPENDENCY`,
    plugin,
    payload: {
      path,
      nodeId,
      connection,
    },
  }
}

module.exports = { actions }
