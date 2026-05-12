// Copyright Contributors to the Open Cluster Management project

/*
 * This file has functions to interact with the Search API.
 */
const { fail } = require('assert')
const request = require('supertest')
const lodash = require('lodash')
const { getLocalClusterName } = require('./clusterAccess')

/**
 * Query the Search API using the given filters.
 *
 * @param {string} kind The kind filter
 * @param {strinig} apigroup The apigroup filter
 * @param {*} cluster The cluster fiilter.
 * @param {string} namespace The namespace filter.
 */
async function getResourcesFromSearch({
  token,
  kind,
  apigroup,
  namespace = '--all-namespaces',
  cluster = { type: 'hub', name: getLocalClusterName() },
}) {
  // Build the search api query.
  const filters = formatFilters(kind, apigroup, namespace, cluster)
  const query = searchQueryBuilder({ filters })
  // Fetch data from the search api.
  const resp = await sendRequest(query, token)

  return lodash.get(resp, 'body.data.searchResult[0].items', [])
}

/**
 * Builds and returns a graphQl query requesting items.
 * Supported input keys: `keywords`, `filters`, `limit`, `offset`, `orderBy`
 * @param {keywords:[], filters:[], limit:number, offset:number, orderBy:string, includeCount:boolean } input The input parameters.
 * @returns {object} The graphQl query object.
 */
function searchQueryBuilder({ keywords = [], filters = [], limit = 10000, offset, orderBy, includeCount = false }) {
  const input = { keywords, filters, limit }
  if (offset !== undefined) input.offset = offset
  if (orderBy !== undefined) input.orderBy = orderBy

  const fields = includeCount ? 'count\n    items' : 'items'
  const query = {
    operationName: 'searchResult',
    variables: { input: [input] },
    query: `query searchResult($input: [SearchInput]) {\n  searchResult: search(input: $input) {\n    ${fields}\n    __typename\n  }\n}\n`,
  }
  return query
}

/**
 * Builds and returns a graphQl query requesting count.
 * @param {keywords:[], filters:[], limit:number } input The input parameters that will be used to build the query object.
 * @returns {object} The graphQl query object.
 */
function searchCountQuery({ keywords = [], filters = [], limit = 10000 }) {
  // Return query built from passed arguments.
  const query = {
    operationName: 'searchCount',
    variables: {
      input: [
        {
          keywords: keywords,
          filters: filters,
          limit: limit,
        },
      ],
    },
    query:
      'query searchCount($input: [SearchInput]) {\n  searchResult: search(input: $input) {\n    count\n    __typename\n  }\n}\n',
  }
  return query
}

/**
 * GraphQL query for searchComplete (distinct values for a property, RBAC-scoped).
 * @param {{ property: string, queryInput?: object|null, limit?: number }} opts
 */
function searchCompleteQuery({ property, queryInput = null, limit = 1000 }) {
  return {
    operationName: 'searchComplete',
    variables: {
      property,
      query: queryInput,
      limit,
    },
    query:
      'query searchComplete($property: String!, $query: SearchInput, $limit: Int) {\n  searchComplete(property: $property, query: $query, limit: $limit)\n}\n',
  }
}

/**
 * Collect metrics from the search requests to evaluate performace.
 * @object { time, token, firstRequest }
 */
const metrics = []

/**
 * Send a HTTP request to the API server and return the results. Expects the response to have a 200 status code.
 * @param {*} query The query to send.
 * @param {string} token The validation token to use for the request.
 * @param {object} options Additional options for sending the request.
 * @param {boolean} [options.skipStatusAssert] If true, do not assert HTTP 200 (for error-path tests).
 * @returns
 */
function sendRequest(query, token, options = {}) {
  // Disable SSL validation so we can connect to the search-api route.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0

  // Monitor how long search took to return results.
  const startTime = Date.now()

  const req = request(searchApiRoute)
    .post('/searchapi/graphql')
    .send(query)
    .set({ Authorization: `Bearer ${token}` })
  const chain = options.skipStatusAssert ? req : req.expect(200)

  return chain.then((r) => {
    const elapsed = Date.now() - startTime

    if (elapsed > 10000) {
      fail(`Search request took more than 10 seconds. (ElapsedTime: ${elapsed.toFixed(2)} ms)
    operation: ${query.operationName}
    variables: ${JSON.stringify(query.variables)}`)
    } else if (elapsed > 1000 && !metrics.map((m) => m.token).includes(token)) {
      // First request takes longer, so we'll log if it takes more than 2 seconds.
      console.log(`Search request took more than 1 second. (ElapsedTime: ${elapsed.toFixed(2)} ms)
    operation: ${query.operationName}
    variables: ${JSON.stringify(query.variables)}`)
    } else if (elapsed > 2000) {
      console.log(`Initial search request took more than 2 seconds. (ElapsedTime: ${elapsed.toFixed(2)} ms)
    operation: ${query.operationName}
    variables: ${JSON.stringify(query.variables)}`)
    }

    metrics.push({ time: elapsed, token, firstRequest: !metrics.map((m) => m.token).includes(token) })
    return r
  })
}

/**
 * Format filters for search queries.
 * @param {string} kind The kind of resource to filter.
 * @param {Object} group The API group to filter the resources against.
 * @param {string} namespace The namespace to filter the resources against.
 * @param {Object} cluster The cluster to filter the resources against.
 * @returns {[filter]} Formatted array of object filters.
 */
function formatFilters(
  kind,
  group,
  namespace = '--all-namespaces',
  cluster = { type: 'hub', name: getLocalClusterName() }
) {
  const filter = []

  // Add namespace filter
  if (namespace !== '--all-namespaces') filter.push({ property: 'namespace', values: [namespace] })

  // Add kind filter
  filter.push({ property: 'kind', values: [kind] })

  // Add group filter
  if (group.useAPIGroup && group.name != 'v1') filter.push({ property: 'apigroup', values: [group.name] })

  // Add cluster filter
  filter.push({ property: 'cluster', values: [cluster.name] })

  return filter
}

/**
 * Sends a search query requesting count.
 * @param {string} token Required. Token of the user initiating the request.
 * @param {keywords:[], filters:[], limit:number } input Required. The search query input.
 * @returns {number} Count of resources matching the search.
 */
async function resolveSearchCount(token, input) {
  const q = searchCountQuery(input)
  const r = await sendRequest(q, token)
  return lodash.get(r, 'body.data.searchResult[0].count', 0)
}

/**
 * Sends a search query requesting items.
 * @param {string} token Required. Token of the user initiating the request.
 * @param {keywords:[], filters:[], limit:number } input Required. The search query input.
 * @returns {[]} Array of resources matching the search.
 */
async function resolveSearchItems(token, input) {
  const q = searchQueryBuilder(input)
  const r = await sendRequest(q, token)
  const items = lodash.get(r, 'body.data.searchResult[0].items', [])
  return items == null ? [] : items
}

exports.getResourcesFromSearch = getResourcesFromSearch
exports.resolveSearchCount = resolveSearchCount
exports.resolveSearchItems = resolveSearchItems
exports.searchCompleteQuery = searchCompleteQuery
exports.searchQueryBuilder = searchQueryBuilder
exports.sendRequest = sendRequest
