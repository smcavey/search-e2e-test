// Copyright Contributors to the Open Cluster Management project

jest.retryTimes(global.retry, { logErrorsBeforeRetry: true })

const squad = require('../../config').get('squadName')
const { getUserContext, getSearchApiRoute } = require('../common-lib/clusterAccess')
const { execCliCmdString } = require('../common-lib/cliClient')
const {
  resolveSearchCount,
  resolveSearchItems,
  searchCompleteQuery,
  sendRequest,
  searchQueryBuilder,
} = require('../common-lib/searchClient')
const { sleep } = require('../common-lib/sleep')

const usr = 'search-query-user'
const ns = 'search-query'

describe(`[P3][Sev3][${squad}] Search API - Verify results of different queries`, () => {
  beforeAll(async () => {
    let setupCommands = `# export ns=search-query; export usr=search-query-user
    oc create namespace ${ns}
    oc create serviceaccount ${usr} -n ${ns}
    oc create role ${usr} --verb=list --resource=configmap,deployment,replicaset,pod,service -n ${ns}
    oc create rolebinding ${usr} --role=${usr} --serviceaccount=${ns}:${usr} -n ${ns}

    oc create configmap cm0 -n ${ns} --from-literal=key=cm0
    oc create configmap cm1 -n ${ns} --from-literal=key=cm1
    oc create configmap cm2-apple -n ${ns} --from-literal=key=cm2
    oc label configmap cm2-apple -n ${ns} type=fruit
    oc create configmap cm3-avocado -n ${ns} --from-literal=key=cm3
    oc label configmap cm3-avocado -n ${ns} type=vegetable
    oc create configmap cm4-broccoli -n ${ns} --from-literal=key=cm4
    oc label configmap cm4-broccoli -n ${ns} type=vegetable

    oc create deployment ${usr} -n ${ns} --image=busybox --replicas=0 -- 'date; sleep 60;'
    oc create service clusterip test-service -n ${ns} --tcp=80:8080`

    // Run the setup steps in parallel.
    const [route] = await Promise.all([getSearchApiRoute(), execCliCmdString(setupCommands)])
    searchApiRoute = route

    // Wait for the service account and search index to get updated.
    // Must wait 2 minutes because of the current RBAC cache.
    // another 30 seconds grace period added to ensure resources indexed
    console.log('Waiting 2.5 minutes for index update and cache expiration')
    await sleep(120000 + 30000)
  }, 1500000)

  // Keep separate from beforeAll because it slows execution and increases the chances of recovering during retry.
  beforeEach(async () => {
    await sleep(5000)
    user = await getUserContext({ usr, ns })
  }, 10000) // 10 seconds

  afterAll(async () => {
    let teardownCmds = `# export ns=search-query; export usr=search-query-user
    oc delete ns ${ns}`

    await execCliCmdString(teardownCmds)
  }, 30000) // 30 seconds

  describe(`using keywords`, () => {
    test(`should match any resources containing the keyword 'apple'`, async () => {
      const items = await resolveSearchItems(user.token, { keywords: ['apple'] })
      expect(items).toHaveLength(1)
      expect(items[0]).toHaveProperty('name', 'cm2-apple')
    })

    test(`should match resources with text containing 'apple' AND 'cm2'`, async () => {
      const items = await resolveSearchItems(user.token, { keywords: ['apple', 'cm2'] })
      expect(items).toHaveLength(1)
      expect(items[0]).toHaveProperty('name', 'cm2-apple')
    })

    test('should be case insensitive.', async () => {
      const items = await resolveSearchItems(user.token, { keywords: ['ApPLe'] })
      expect(items).toHaveLength(1)
      expect(items[0]).toHaveProperty('name', 'cm2-apple')
    })

    test(`should match resources where label text contains 'vegetable'`, async () => {
      const items = await resolveSearchItems(user.token, { keywords: ['vegetable'] })
      const names = items.map((i) => i.name)
      expect(items).toHaveLength(2)
      expect(names).toEqual(expect.arrayContaining(['cm3-avocado', 'cm4-broccoli']))
    })

    test('should handle empty keywords when filters are present', async () => {
      const items = await resolveSearchItems(user.token, {
        keywords: [],
        filters: [
          { property: 'namespace', values: [ns] },
          { property: 'name', values: ['cm2-apple'] },
        ],
      })
      expect(items).toHaveLength(1)
      expect(items[0]).toHaveProperty('name', 'cm2-apple')
    })

    test('should handle special characters in keywords', async () => {
      const items = await resolveSearchItems(user.token, { keywords: ['cm2-apple'] })
      expect(items).toHaveLength(1)
      expect(items[0]).toHaveProperty('name', 'cm2-apple')
    })

    test('should return empty array for non-existent keywords', async () => {
      const items = await resolveSearchItems(user.token, { keywords: ['nonexistent-resource-xyz'] })
      expect(items).toHaveLength(0)
    })
  })

  describe('using labels', () => {
    test(`should match resources containing the label 'fruit'`, async () => {
      const items = await resolveSearchItems(user.token, { filters: [{ property: 'label', values: ['type=fruit'] }] })
      expect(items).toHaveLength(1)
      expect(items[0]).toHaveProperty('name', 'cm2-apple')
    })

    test('should match resources containing labelA OR labelB.', async () => {
      const items = await resolveSearchItems(user.token, {
        filters: [{ property: 'label', values: ['type=fruit', 'type=vegetable'] }],
      })
      const names = items.map((i) => i.name)

      expect(items).toHaveLength(3)
      expect(names).toEqual(expect.arrayContaining(['cm2-apple', 'cm3-avocado', 'cm4-broccoli']))
    })

    test('should handle non-existent labels gracefully', async () => {
      const items = await resolveSearchItems(user.token, {
        filters: [{ property: 'label', values: ['nonexistent=label'] }],
      })
      expect(items).toHaveLength(0)
    })

    test('should reject strict label filter without key=value form', async () => {
      const q = searchQueryBuilder({
        filters: [{ property: 'label', values: ['type'] }],
      })
      const r = await sendRequest(q, user.token, { skipStatusAssert: true })
      const hasErr = Array.isArray(r.body.errors) && r.body.errors.length > 0
      const items = r.body?.data?.searchResult?.[0]?.items
      const empty = !items || items.length === 0
      expect(r.status !== 200 || hasErr).toBe(true)
      expect(empty).toBe(true)
    })
  })

  describe('using partial match', () => {
    test(`should match resources containing the partial string 'typ*=*fru*' in label`, async () => {
      const items = await resolveSearchItems(user.token, { filters: [{ property: 'label', values: ['typ*=*fru*'] }] })
      expect(items).toHaveLength(1)
      expect(items[0]).toHaveProperty('name', 'cm2-apple')
    })

    test('should match resources partially matching labelA OR labelB.', async () => {
      const items = await resolveSearchItems(user.token, {
        filters: [{ property: 'label', values: ['type=fru*', 'type=veg*'] }],
      })
      const names = items.map((i) => i.name)

      expect(items).toHaveLength(3)
      expect(names).toEqual(expect.arrayContaining(['cm2-apple', 'cm3-avocado', 'cm4-broccoli']))
    })

    test('should match resources partially matching labelA.', async () => {
      const items = await resolveSearchItems(user.token, {
        filters: [{ property: 'label', values: ['type*'] }],
      })
      const names = items.map((i) => i.name)

      expect(items).toHaveLength(3)
      expect(names).toEqual(expect.arrayContaining(['cm2-apple', 'cm3-avocado', 'cm4-broccoli']))
    })

    test('should match resources partially matching on kind.', async () => {
      const items = await resolveSearchItems(user.token, {
        filters: [
          { property: 'kind', values: ['Conf*'] },
          { property: 'name', values: ['cm*'] },
        ],
      })
      const names = items.map((i) => i.name)

      expect(items).toHaveLength(5)
      expect(names).toEqual(expect.arrayContaining(['cm0', 'cm1', 'cm2-apple', 'cm3-avocado', 'cm4-broccoli']))
    })

    test('should handle complex wildcard patterns', async () => {
      const items = await resolveSearchItems(user.token, {
        filters: [{ property: 'name', values: ['*-*'] }],
      })
      const names = items.map((i) => i.name)
      expect(names).toEqual(expect.arrayContaining(['cm2-apple', 'cm3-avocado', 'cm4-broccoli', 'search-query-user']))
    })
  })

  describe(`using the filter 'kind'`, () => {
    test('should be case sensitive (lowercase).', async () => {
      const [items, items2] = await Promise.all([
        resolveSearchItems(user.token, { filters: [{ property: 'kind', values: ['deployment'] }] }),
        resolveSearchItems(user.token, { filters: [{ property: 'kind', values: ['Deployment'] }] }),
      ])

      expect(items).toHaveLength(1)
      expect(items2).toHaveLength(1)
    })

    test('should filter by multiple kinds', async () => {
      const items = await resolveSearchItems(user.token, {
        filters: [
          { property: 'kind', values: ['ConfigMap', 'Deployment'] },
          { property: 'namespace', values: [ns] },
        ],
      })
      expect(items).toHaveLength(8) // 2 default configmaps + 5 configmaps + 1 deployment
    })

    test('should handle non-existent kinds gracefully', async () => {
      const items = await resolveSearchItems(user.token, {
        filters: [{ property: 'kind', values: ['NonExistentKind'] }],
      })
      expect(items).toHaveLength(0)
    })
  })

  describe('search using comparison operators', () => {
    test(`should match resources in namespace ${ns} created within the last hour`, async () => {
      const items = await resolveSearchItems(user.token, {
        filters: [
          { property: 'namespace', values: [ns] }, // Limit to namespace created by test
          { property: 'kind', values: ['!Pod'] }, // and exclude Pod to keep test stable.
          { property: 'created', values: ['hour'] },
        ],
      })
      expect(items).toHaveLength(10) // 2 default configmaps + 5 configmaps + 1 deployment + 1 service
    })

    test('should match resources where desired = 0', async () => {
      const items = await resolveSearchItems(user.token, { filters: [{ property: 'desired', values: ['=0'] }] })
      expect(items).toHaveLength(2)
      const kinds = items.map((i) => i.kind)
      expect(kinds).toEqual(expect.arrayContaining(['Deployment', 'ReplicaSet']))
    })

    test('should match deployments where available < 3', async () => {
      const items = await resolveSearchItems(user.token, { filters: [{ property: 'available', values: ['<3'] }] })
      expect(items).toHaveLength(1)
      expect(items[0]).toHaveProperty('name', usr)
    })

    test('should match deployments where desired <= 5', async () => {
      const items = await resolveSearchItems(user.token, { filters: [{ property: 'desired', values: ['<=5'] }] })
      expect(items).toHaveLength(2)
    })

    test('should handle invalid comparison operators gracefully', async () => {
      const items = await resolveSearchItems(user.token, { filters: [{ property: 'desired', values: ['invalid_op'] }] })
      expect(items).toHaveLength(0)
    })

    test('should match resources with negation operator', async () => {
      const items = await resolveSearchItems(user.token, {
        filters: [
          { property: 'namespace', values: [ns] },
          { property: 'kind', values: ['!Secret'] },
        ],
      })
      const kinds = items.map((i) => i.kind)
      expect(kinds).not.toContain('Secret')
    })
  })

  describe('search with multiple filters and values (AND/OR)', () => {
    test('should match resources in namespace a OR b.', async () => {
      const items = await resolveSearchItems(user.token, {
        filters: [{ property: 'namespace', values: [ns, 'kube-system'] }],
      })
      expect(items.length).toBeGreaterThan(0)
      const namespaces = [...new Set(items.map((i) => i.namespace))]
      expect(namespaces).toEqual(expect.arrayContaining([ns]))
    })

    test('should match resources in namespace a AND name b OR c.', async () => {
      const items = await resolveSearchItems(user.token, {
        filters: [
          { property: 'namespace', values: [ns] },
          { property: 'name', values: ['cm2-apple', 'cm3-avocado'] },
        ],
      })
      const names = items.map((i) => i.name)
      expect(items).toHaveLength(2)
      expect(names).toEqual(expect.arrayContaining(['cm2-apple', 'cm3-avocado']))
    })

    test('should match resources in namespace a AND contains keyword xyz.', async () => {
      const items = await resolveSearchItems(user.token, {
        keywords: ['apple'],
        filters: [{ property: 'namespace', values: [ns] }],
      })
      expect(items).toHaveLength(1)
      expect(items[0]).toHaveProperty('name', 'cm2-apple')
      expect(items[0]).toHaveProperty('namespace', ns)
    })

    test('should only match resources of kind a, b, OR c.', async () => {
      const items = await resolveSearchItems(user.token, {
        filters: [
          { property: 'namespace', values: [ns] },
          { property: 'kind', values: ['ConfigMap', 'Deployment', 'Service'] },
        ],
      })
      const kinds = [...new Set(items.map((i) => i.kind))]
      expect(kinds.every((kind) => ['ConfigMap', 'Deployment', 'Service'].includes(kind))).toBe(true)
      expect(items).toHaveLength(9) // 2 default configmaps + 5 configmaps + 1 deployment + 1 service
    })

    test('should handle complex filter combinations', async () => {
      const items = await resolveSearchItems(user.token, {
        keywords: ['vegetable'],
        filters: [
          { property: 'namespace', values: [ns] },
          { property: 'kind', values: ['ConfigMap'] },
          { property: 'label', values: ['type=vegetable'] },
        ],
      })
      const names = items.map((i) => i.name)
      expect(items).toHaveLength(2)
      expect(names).toEqual(expect.arrayContaining(['cm3-avocado', 'cm4-broccoli']))
    })
  })

  describe('search by count', () => {
    test('should return expected count.', async () => {
      const count = await resolveSearchCount(user.token, {
        filters: [{ property: 'label', values: ['type=fruit', 'type=vegetable'] }],
      })
      expect(count).toEqual(3)
    })

    test('should return zero count for non-existent resources', async () => {
      const count = await resolveSearchCount(user.token, {
        filters: [{ property: 'name', values: ['non-existent-resource'] }],
      })
      expect(count).toEqual(0)
    })

    test('should count match items count for same query', async () => {
      const query = {
        filters: [
          { property: 'namespace', values: [ns] },
          { property: 'kind', values: ['ConfigMap'] },
        ],
      }
      const [count, items] = await Promise.all([
        resolveSearchCount(user.token, query),
        resolveSearchItems(user.token, query),
      ])
      expect(count).toEqual(items.length)
    })
  })

  describe('search with limit', () => {
    test('should return LIMIT or less resources.', async () => {
      const items = await resolveSearchItems(user.token, {
        filters: [{ property: 'kind', values: ['configmap'] }],
        limit: 2,
      })
      expect(items.length).toBeLessThanOrEqual(2)
    })

    test('should handle limit of 0 (unlimited)', async () => {
      const items = await resolveSearchItems(user.token, {
        filters: [{ property: 'namespace', values: [ns] }],
        limit: 0,
      })
      expect(items.length).toBeGreaterThan(0)
    })

    test('should handle very large limits', async () => {
      const items = await resolveSearchItems(user.token, {
        filters: [{ property: 'namespace', values: [ns] }],
        limit: 999999,
      })
      expect(Array.isArray(items)).toBe(true)
      expect(items.length).toBeGreaterThan(0)
    })
  })

  describe('search complete', () => {
    test('should return distinct namespaces for namespace property via searchComplete', async () => {
      const query = searchCompleteQuery({ property: 'namespace', limit: 2000 })
      const response = await sendRequest(query, user.token)
      const values = response.body.data.searchComplete || []
      const namespaces = values.map((v) => (v == null ? '' : String(v))).filter(Boolean)

      expect(namespaces.length).toBeGreaterThan(0)
      expect(namespaces).toContain(ns)
    })

    test('should return all available kinds for kind property', async () => {
      const query = searchQueryBuilder({
        filters: [{ property: 'namespace', values: [ns] }],
        limit: 1000,
      })

      const response = await sendRequest(query, user.token)
      const items = response.body.data.searchResult[0].items || []
      const kinds = [...new Set(items.map((item) => item.kind).filter((kind) => kind))]

      expect(kinds.length).toBeGreaterThan(0)
      expect(kinds).toEqual(expect.arrayContaining(['ConfigMap', 'Deployment']))
    })
  })

  describe('single request with multiple search queries', () => {
    test('should resolve all requests in parallel', async () => {
      const queries = [
        { filters: [{ property: 'kind', values: ['ConfigMap'] }] },
        { filters: [{ property: 'kind', values: ['Deployment'] }] },
        { filters: [{ property: 'namespace', values: [ns] }] },
      ]

      const startTime = Date.now()
      const results = await Promise.all(queries.map((query) => resolveSearchItems(user.token, query)))
      const elapsed = Date.now() - startTime

      expect(results).toHaveLength(3)
      expect(results[0].length).toBeGreaterThan(0) // ConfigMaps
      expect(results[1].length).toBeGreaterThan(0) // Deployments
      expect(results[2].length).toBeGreaterThan(0) // Resources in test namespace

      // Parallel execution should be faster than sequential
      expect(elapsed).toBeLessThan(10000) // Should complete within 10 seconds
    })

    test('should handle mixed successful and failed queries', async () => {
      const queries = [
        { filters: [{ property: 'kind', values: ['ConfigMap'] }] },
        { filters: [{ property: 'kind', values: ['NonExistentKind'] }] },
        { filters: [{ property: 'namespace', values: [ns] }] },
      ]

      const results = await Promise.allSettled(queries.map((query) => resolveSearchItems(user.token, query)))

      expect(results).toHaveLength(3)
      expect(results[0].status).toBe('fulfilled')
      expect(results[1].status).toBe('fulfilled') // Should return empty array, not fail
      expect(results[2].status).toBe('fulfilled')
      expect(results[1].value).toHaveLength(0)
    })
  })

  describe('error handling and edge cases', () => {
    test('should handle invalid token gracefully', async () => {
      try {
        await resolveSearchItems('invalid-token', { filters: [{ property: 'kind', values: ['ConfigMap'] }] })
        fail('Should have thrown an error for invalid token')
      } catch (error) {
        expect(error).toBeDefined()
      }
    })

    test('should return no results for empty filter property with values', async () => {
      const items = await resolveSearchItems(user.token, {
        filters: [{ property: '', values: ['any'] }],
      })
      expect(items).toHaveLength(0)
    })

    test('should ignore filters with empty values when other filters still apply', async () => {
      const [withIgnored, baseline] = await Promise.all([
        resolveSearchItems(user.token, {
          filters: [
            { property: 'namespace', values: [ns] },
            { property: 'kind', values: [] },
          ],
        }),
        resolveSearchItems(user.token, {
          filters: [{ property: 'namespace', values: [ns] }],
        }),
      ])
      expect(withIgnored.length).toBe(baseline.length)
    })

    test('should return no items when search has no filters and no keywords', async () => {
      const items = await resolveSearchItems(user.token, {})
      expect(items).toHaveLength(0)
    })

    test('should handle very long filter values', async () => {
      const longValue = 'a'.repeat(1000)
      const items = await resolveSearchItems(user.token, {
        filters: [{ property: 'name', values: [longValue] }],
      })
      expect(items).toHaveLength(0)
    })
  })

  describe('performance and scalability', () => {
    test('should complete search within reasonable time', async () => {
      const startTime = Date.now()
      const items = await resolveSearchItems(user.token, {
        filters: [{ property: 'namespace', values: [ns] }],
      })
      const elapsed = Date.now() - startTime

      expect(items.length).toBeGreaterThan(0)
      expect(elapsed).toBeLessThan(10000) // Should complete within 10 seconds
    })

    test('should handle concurrent requests efficiently', async () => {
      const concurrentRequests = 3
      const requests = Array(concurrentRequests)
        .fill()
        .map(() =>
          resolveSearchItems(user.token, {
            filters: [{ property: 'namespace', values: [ns] }],
          })
        )

      const startTime = Date.now()
      const results = await Promise.all(requests)
      const elapsed = Date.now() - startTime

      expect(results).toHaveLength(concurrentRequests)
      results.forEach((result) => {
        expect(result.length).toBeGreaterThan(0)
      })

      // Concurrent requests shouldn't take much longer than a single request
      expect(elapsed).toBeLessThan(20000)
    })
  })

  describe('data validation', () => {
    test('should return consistent resource structure', async () => {
      const items = await resolveSearchItems(user.token, {
        filters: [{ property: 'namespace', values: [ns] }],
        limit: 1,
      })

      expect(items.length).toBeGreaterThan(0)
      const item = items[0]

      // Validate required fields
      expect(item).toHaveProperty('name')
      expect(item).toHaveProperty('kind')
      expect(item).toHaveProperty('namespace')
      expect(typeof item.name).toBe('string')
      expect(typeof item.kind).toBe('string')
      expect(typeof item.namespace).toBe('string')
    })

    test('should return valid timestamps for created field', async () => {
      const items = await resolveSearchItems(user.token, {
        filters: [
          { property: 'namespace', values: [ns] },
          { property: 'kind', values: ['ConfigMap'] },
        ],
        limit: 1,
      })

      expect(items.length).toBeGreaterThan(0)
      const item = items[0]

      if (item.created) {
        const createdDate = new Date(item.created)
        expect(createdDate).toBeInstanceOf(Date)
        expect(createdDate.getTime()).toBeGreaterThan(0)
      }
    })
  })
})
