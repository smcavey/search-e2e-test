// Copyright Contributors to the Open Cluster Management project

jest.retryTimes(global.retry, { logErrorsBeforeRetry: true })

const { execSync } = require('child_process')

const squad = require('../../config').get('squadName')
const { getSearchApiRoute, getKubeadminToken, getLocalClusterName } = require('../common-lib/clusterAccess')
const { searchQueryBuilder, sendRequest } = require('../common-lib/searchClient')

function resolveAcmNamespace() {
  if (process.env.CYPRESS_ACM_NAMESPACE) {
    return process.env.CYPRESS_ACM_NAMESPACE
  }
  try {
    const v = execSync("oc get mch -A -o jsonpath='{.items[0].metadata.namespace}'", {
      stdio: ['pipe', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
    return v || 'open-cluster-management'
  } catch (_) {
    return 'open-cluster-management'
  }
}

const acmNamespace = resolveAcmNamespace()

describe('RHACM4K-1696: Search API - Verify search result with common filter and conditions', () => {
  beforeAll(async () => {
    // Log in and get access token
    token = getKubeadminToken()

    // Create a route to access the Search API.
    searchApiRoute = await getSearchApiRoute()
  })

  test(`[P2][Sev2][${squad}] with query {kind:Deployment name:console namespace:openshift-console}`, async () => {
    var query = searchQueryBuilder({
      filters: [
        { property: 'kind', values: ['Deployment'] },
        { property: 'name', values: ['console'] },
        { property: 'namespace', values: ['openshift-console'] },
      ],
    })
    var res = await sendRequest(query, token)
    expect(res.body.data.searchResult[0].items[0].kind).toMatch(/Deployment/i)
    expect(res.body.data.searchResult[0].items[0].name).toEqual('console')
    expect(res.body.data.searchResult[0].items[0].namespace).toEqual('openshift-console')
  }, 20000)

  test(`[P2][Sev2][${squad}] with query {kind:Pod status:Running namespace:${acmNamespace}}`, async () => {
    var query = searchQueryBuilder({
      filters: [
        { property: 'kind', values: ['Pod'] },
        { property: 'namespace', values: [acmNamespace] },
        { property: 'status', values: ['Running'] },
      ],
    })
    var res = await sendRequest(query, token)
    var pods = res.body.data.searchResult[0].items
    pods.forEach((element) => {
      expect(element.status).toEqual('Running')
    })
  }, 20000)

  test(`[P2][Sev2][${squad}] with query {kind:Pod cluster:local-cluster}`, async () => {
    var query = searchQueryBuilder({
      filters: [
        { property: 'kind', values: ['Pod'] },
        { property: 'cluster', values: [getLocalClusterName()] },
        { property: 'status', values: ['Running'] },
      ],
    })
    var res = await sendRequest(query, token)
    var pods = res.body.data.searchResult[0].items
    pods.forEach((element) => {
      expect(element.status).toEqual('Running')
    })
  }, 20000)

  test(`[P2][Sev2][${squad}] with query {kind:ConfigMap namespace:${acmNamespace}}`, async () => {
    var query = searchQueryBuilder({
      filters: [
        { property: 'kind', values: ['ConfigMap'] },
        { property: 'namespace', values: [acmNamespace] },
      ],
    })

    var res = await sendRequest(query, token)
    var items = res.body.data.searchResult[0].items || []

    expect(items.length).toBeGreaterThan(0)
    const inNs = items.filter((el) => el.namespace === acmNamespace)
    expect(inNs.length).toBeGreaterThan(0)
    expect(inNs.every((el) => /ConfigMap/i.test(String(el.kind)))).toBe(true)
    expect(inNs.some((el) => String(el.name).includes('search'))).toBe(true)
  }, 20000)

  test(`[P2][Sev2][${squad}] with query {kind:Deployment namespace:${acmNamespace}}`, async () => {
    var query = searchQueryBuilder({
      filters: [
        { property: 'kind', values: ['Deployment'] },
        { property: 'namespace', values: [acmNamespace] },
      ],
    })

    var res = await sendRequest(query, token)
    var items = res.body.data.searchResult[0].items || []

    expect(items.length).toBeGreaterThan(0)
    const inNs = items.filter((el) => el.namespace === acmNamespace)
    expect(inNs.length).toBeGreaterThan(0)
    expect(inNs.every((el) => /Deployment/i.test(String(el.kind)))).toBe(true)
    expect(inNs.some((el) => String(el.name).includes('search'))).toBe(true)
  }, 20000)
})
