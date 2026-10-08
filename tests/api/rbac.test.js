// Copyright Contributors to the Open Cluster Management project

jest.retryTimes(global.retry, { logErrorsBeforeRetry: true, waitBeforeRetry: 60000 })

const squad = require('../../config').get('squadName')
const { getUserContext, getSearchApiRoute, getKubeadminToken } = require('../common-lib/clusterAccess')
const { ValidateSearchData, validationTimeout } = require('../common-lib/validateSearchData')
const { resolveSearchItems } = require('../common-lib/searchClient')
const { execSync } = require('child_process')
const { execCliCmdString, expectCli } = require('../common-lib/cliClient')
const { sleep } = require('../common-lib/sleep')
const { waitForIndexedResourcesViaSubscription } = require('../common-lib/subscriptionClient')

const ns = 'search-rbac'
const [usr0, usr1, usr2, usr3, usr4] = ['search-user0', 'search-user1', 'search-user2', 'search-user3', 'search-user4']
const usr1Role = 'search-user1-role'
const usr1Rb = 'search-user1-rb'
const usr2Cr = 'search-user2-cr'
const usr2Crb = 'search-user2-crb'
const usr3Rb = 'search-user3-rb'
const usr4Role = 'search-user4-role'
const usr4Rb = 'search-user4-rb'
const usr4Deploy = 'search-user4-deploy'

const requiredFixtures = [
  { name: usr0 },
  { name: usr1 },
  { name: usr2 },
  { name: usr3 },
  { name: usr4 },
  { name: usr1Role },
  { name: usr1Rb },
  { name: usr3Rb },
  { name: usr4Role },
  { name: usr4Rb },
  { name: usr4Deploy },
  { name: 'cm0' },
  { name: 'cm1' },
]

describe(`[P2][Sev2][${squad}] Search API: Verify RBAC`, () => {
  beforeAll(async () => {
    token = getKubeadminToken()

    // Get the search API route first — we need the websocket URL before setup runs.
    searchApiRoute = await getSearchApiRoute()
    const websocketUrl = searchApiRoute.replace('https://', 'wss://')

    // Phase 1: Register the watch subscription BEFORE creating any fixtures.
    // subscriptionReady resolves once the subscribe frame has been sent to the
    // server (after connection_ack). Awaiting it guarantees no INSERT/UPDATE
    // event can be emitted before the server-side filter is active.
    const { subscriptionReady, done: readinessPromise } = waitForIndexedResourcesViaSubscription(
      websocketUrl,
      token,
      ns,
      requiredFixtures
    )
    await subscriptionReady
    // Using ServiceAccounts for rbac tests because configuration is simpler.

    const setupCmds = `
    # export ns=search-rbac; export usr0=search-user0; export usr1=search-user1; export usr2=search-user2; export usr3=search-user3; 
    # export usr4=search-user4; export usr1Role=search-user1-role; export usr1Rb=search-user1-rb; export usr2Cr=search-user2-cr; 
    # export usr2Crb=search-user2-crb; export usr3Rb=search-user3-rb; export usr4Role=search-user4-role; export usr4Rb=search-user4-rb; export usr4Deploy=search-user4-deploy
    oc create namespace ${ns}
    oc create serviceaccount ${usr0} -n ${ns}
    oc create serviceaccount ${usr1} -n ${ns}
    oc create serviceaccount ${usr2} -n ${ns}
    oc create serviceaccount ${usr3} -n ${ns}
    oc create serviceaccount ${usr4} -n ${ns}
    oc create role ${usr1Role} --verb=list --resource=configmaps -n ${ns}
    oc create rolebinding ${usr1Rb} --role=${usr1Role} --serviceaccount=${ns}:${usr1} -n ${ns}
    oc create clusterrole ${usr2Cr} --verb=list --resource=nodes,configmaps
    oc create clusterrolebinding ${usr2Crb} --clusterrole=${usr2Cr} --serviceaccount=${ns}:${usr2}
    oc create rolebinding ${usr3Rb} --clusterrole=admin --serviceaccount=${ns}:${usr3} -n ${ns}
    oc create role ${usr4Role} --verb=list --resource=deployment -n ${ns}
    oc create rolebinding ${usr4Rb} --role=${usr4Role} --serviceaccount=${ns}:${usr4} -n ${ns}
    oc create deployment ${usr4Deploy} -n ${ns} --image=busybox --replicas=1 -- 'date; sleep 60;'
    oc patch deployment ${usr4Deploy} -n ${ns} -p '{"spec":{"template":{"spec":{"containers":[{"name":"busybox","imagePullPolicy":"IfNotPresent"}]}}}}'
    oc scale deployment ${usr4Deploy} -n ${ns} --replicas=5
    oc create configmap cm0 -n ${ns} --from-literal=key=cm0
    oc create configmap cm1 -n ${ns} --from-literal=key=cm1
    oc create clusterrole ${ns}-userpermissions --verb=list --resource=userpermissions.clusterview.open-cluster-management.io
    oc create clusterrolebinding ${usr0}-userpermissions --clusterrole=${ns}-userpermissions --serviceaccount=${ns}:${usr0}
    oc create clusterrolebinding ${usr1}-userpermissions --clusterrole=${ns}-userpermissions --serviceaccount=${ns}:${usr1}
    oc create clusterrolebinding ${usr2}-userpermissions --clusterrole=${ns}-userpermissions --serviceaccount=${ns}:${usr2}
    oc create clusterrolebinding ${usr3}-userpermissions --clusterrole=${ns}-userpermissions --serviceaccount=${ns}:${usr3}
    oc create clusterrolebinding ${usr4}-userpermissions --clusterrole=${ns}-userpermissions --serviceaccount=${ns}:${usr4}`

    await execCliCmdString(setupCmds)

    // Phase 3: Wait for RBAC cache expiration (2 min) and all fixtures to be indexed.
    // The subscription notifies us as soon as each event arrives in the search index.
    // Both waits run concurrently — total wait is whichever takes longer.
    console.log('Waiting for RBAC cache expiration and resources to be indexed via subscription...')
    await Promise.all([sleep(120000), readinessPromise])
    console.log('Setup complete. Starting tests...')
  }, 350000) // 5.5 minutes

  afterAll(async () => {
    const teardownCmds = `
    # export ns=search-rbac; export usr2Crb=search-user2-crb; export usr2Cr=search-user2-cr
    oc delete ns ${ns}
    oc delete clusterrolebinding ${usr2Crb}
    oc delete clusterrole ${usr2Cr}
    oc delete clusterrolebinding ${usr0}-userpermissions
    oc delete clusterrolebinding ${usr1}-userpermissions
    oc delete clusterrolebinding ${usr2}-userpermissions
    oc delete clusterrolebinding ${usr3}-userpermissions
    oc delete clusterrolebinding ${usr4}-userpermissions
    oc delete clusterrole ${ns}-userpermissions`

    await execCliCmdString(teardownCmds)
  }, 10000)

  describe(`with user ${usr0} (no special authorization, only default)`, () => {
    beforeAll(async () => {
      user = await getUserContext({ usr: usr0, ns })
    })

    test('should validate RBAC configuration for user', () => {
      expectCli(`oc auth can-i list secret --as=${user.fullName}`).toThrow()
      expectCli(`oc auth can-i list configmap --as=${user.fullName}`).toThrow()
      expectCli(`oc auth can-i list node --as=${user.fullName}`).toThrow()
    })

    test('should not receive ConfigMap', () => ValidateSearchData({ user, kind: 'configmap' }), validationTimeout)
    test('should not receive Node', () => ValidateSearchData({ user, kind: 'node' }), validationTimeout)
    test('should not receive Secret', () => ValidateSearchData({ user, kind: 'secret' }), validationTimeout)

    test(`should not match any resources containing the keyword 'cm0' or 'cm1`, async () => {
      const items = await resolveSearchItems(user.token, { keywords: ['cm0', 'cm1'] })
      expect(items).toHaveLength(0)
      expect(items).toEqual([])
    })

    test(`should not match any resources in namespace ${ns}`, async () => {
      const items = await resolveSearchItems(user.token, { filters: [{ property: 'namespace', values: [ns] }] })
      expect(items).toHaveLength(0)
      expect(items).toEqual([])
    })
  })

  describe(`with user ${usr1} (configmap in namespace ${ns} only)`, () => {
    beforeAll(async () => {
      user = await getUserContext({ usr: usr1, ns })
    })

    test('should validate RBAC configuration for user', () => {
      expect(() => execSync(`oc auth can-i list secret -n ${ns} --as=${user.fullName}`)).toThrow()
      expect(() => execSync(`oc auth can-i list configmap -n ${ns} --as=${user.fullName}`)).not.toThrow()
    })

    test('should not receive Secret', () => ValidateSearchData({ user, kind: 'secret' }), validationTimeout)
    test('should receive ConfigMap', () => ValidateSearchData({ user, kind: 'configmap' }), validationTimeout)

    test(`should not match any ConfigMap from other namespaces`, async () => {
      const items = await resolveSearchItems(user.token, { filters: [{ property: 'kind', values: ['configmap'] }] })
      expect(items.find(({ namespace }) => namespace && namespace.toLowerCase() !== ns)).toEqual(undefined)
      expect(items.find(({ kind }) => kind && kind.toLowerCase() !== 'configmap')).toEqual(undefined)
    })

    test(`should not match any other resources in the namespace`, async () => {
      const items = await resolveSearchItems(user.token, {
        filters: [
          { property: 'namespace', values: [ns] },
          { property: 'kind', values: ['!ConfigMap'] },
        ],
      })
      expect(items).toHaveLength(0)
      expect(items).toEqual([])
    })
  })

  describe(`with user ${usr2} (nodes and configmap in all namespaces.)`, () => {
    beforeAll(async () => {
      user = await getUserContext({ usr: usr2, ns })
    })

    test('should validate RBAC configuration for user', () => {
      expectCli(`oc auth can-i list secret -n ${ns} --as=${user.fullName}`).toThrow()
      expectCli(`oc auth can-i list configmap -A --as=${user.fullName}`).not.toThrow()
      expectCli(`oc auth can-i list configmap -n ${ns} --as=${user.fullName}`).not.toThrow()
      expectCli(`oc auth can-i list node --as=${user.fullName}`).not.toThrow()
    })

    test('should not receive Secret', () => ValidateSearchData({ user, kind: 'secret' }), validationTimeout)
    test('should receive ConfigMap', () => ValidateSearchData({ user, kind: 'configmap' }), validationTimeout)
    test('should receive Node', () => ValidateSearchData({ user, kind: 'node' }), validationTimeout)
  })

  describe(`with user ${usr3} (admin for namespace ${ns})`, () => {
    beforeAll(async () => {
      user = await getUserContext({ usr: usr3, ns })
    })

    test('should validate RBAC configuration for user', () => {
      expectCli(`oc auth can-i list secret -n ${ns} --as=${user.fullName}`).not.toThrow()
      expectCli(`oc auth can-i list configmap -n ${ns} --as=${user.fullName}`).not.toThrow()
      expectCli(`oc auth can-i list configmap -n default --as=${user.fullName}`).toThrow()
      expectCli(`oc auth can-i list node --as=${user.fullName}`).toThrow()
    })

    test('should receive Secret', () => ValidateSearchData({ user, kind: 'secret' }), validationTimeout)
    test('should receive ConfigMap', () => ValidateSearchData({ user, kind: 'configmap' }), validationTimeout)
    test('should not receive Node', () => ValidateSearchData({ user, kind: 'node' }), validationTimeout)

    /* FIXME: Keeping this test disabled because user is also getting authorized to get ConfigMaps in
     * open-cluster-management. This is coming from Kubernetes, not search.
    test(`should not match resources from other namespaces`, async () => {
      expect(() => execSync(`oc auth can-i list configmap -n open-cluster-management --as=${user.fullName}`)).toThrow()
      const q = searchQueryBuilder({ filters: [{ property: 'kind', values: ['configmap'] }] })
      const res = await sendRequest(q, user.token)
      const items = res.body.data.searchResult[0].items

      expect(items.find(({ namespace }) => namespace.toLowerCase() !== ns)).toEqual(undefined)
    })
    */
  })

  describe(`with user ${usr4} (access to deployment but not pod)`, () => {
    beforeAll(async () => {
      user = await getUserContext({ usr: usr4, ns })
    })

    test('should validate RBAC configuration.', () => {
      expectCli(`oc auth can-i list secret -n ${ns} --as=${user.fullName}`).toThrow()
      expectCli(`oc auth can-i list pod -n ${ns} --as=${user.fullName}`).toThrow()
      expectCli(`oc auth can-i list deployment -n ${ns} --as=${user.fullName}`).not.toThrow()
    })

    test(`should not get Secret`, () => ValidateSearchData({ user, kind: 'secret', namespace: ns }), validationTimeout)
    test('should not get Pod', () => ValidateSearchData({ user, kind: 'configmap', namespace: ns }), validationTimeout)
    test(
      'should get Deploymt',
      () => ValidateSearchData({ user, kind: 'deployment', namespace: ns }),
      validationTimeout
    )

    test.todo('should validate relationship data is correct.')
  })

  // TODO: This scenario is not supported in V1 and not implemented for V2 yet.
  describe(`with user search-user5 (access to configmap cm0 only)`, () => {
    test.todo('should validate RBAC configuration.')
    test.todo('should validate results from search.')
  })

  describe(`with user search-user10 (all managed clusters)`, () => {
    test.todo('should validate RBAC configuration.')
    test.todo('should validate results from search.')
  })

  describe(`with user search-user11 (single managed cluster)`, () => {
    test.todo('should validate RBAC configuration.')
    test.todo('should validate results from search.')
  })
})
