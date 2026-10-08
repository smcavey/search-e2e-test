// Copyright Contributors to the Open Cluster Management project

jest.retryTimes(global.retry, { logErrorsBeforeRetry: true, waitBeforeRetry: 60000 })

const squad = require('../../config').get('squadName')
const { getUserContext, getSearchApiRoute } = require('../common-lib/clusterAccess')
const { ValidateSearchData, validationTimeout } = require('../common-lib/validateSearchData')
const { resolveSearchItems } = require('../common-lib/searchClient')
const { execCliCmdString, expectCli } = require('../common-lib/cliClient')
const { sleep } = require('../common-lib/sleep')

const ns = 'search-global-rbac'
const [usr0] = ['global-search-user']

describe(`[P2][Sev2][${squad}] Search API: Verify RBAC with Global Search Cluster role`, () => {
  beforeAll(async () => {
    // Using ServiceAccounts for rbac tests because configuration is simpler.

    const setupCmds = `
    # export ns=search-global-rbac; export usr0=u0;
    oc create namespace ${ns}
    oc create serviceaccount ${usr0} -n ${ns}
    oc create clusterrole ${usr0} --verb=get --resource=searches.search.open-cluster-management.io,searches/allManagedData
    oc create clusterrolebinding ${usr0} --clusterrole=${usr0} --serviceaccount=${ns}:${usr0}
    oc create clusterrole ${usr0}-userpermissions --verb=list --resource=userpermissions.clusterview.open-cluster-management.io
    oc create clusterrolebinding ${usr0}-userpermissions --clusterrole=${usr0}-userpermissions --serviceaccount=${ns}:${usr0}
  

    oc create configmap cm0 -n ${ns} --from-literal=key=cm0
    oc create configmap cm1 -n ${ns} --from-literal=key=cm1`

    // Run setup steps in parallel.
    // - Create a route to access the Search API.
    // - Create users and objects for this test.
    const [route] = await Promise.all([getSearchApiRoute(), execCliCmdString(setupCmds)])
    searchApiRoute = route

    await sleep(10000) // Wait for service account and the search index to get updated.
  }, 60000)

  afterAll(async () => {
    const teardownCmds = `
    # export ns=search-global-rbac; export usr0=u0
    oc delete ns ${ns}
    oc delete clusterrolebinding ${usr0}
    oc delete clusterrole ${usr0}
    oc delete clusterrolebinding ${usr0}-userpermissions
    oc delete clusterrole ${usr0}-userpermissions`

    await execCliCmdString(teardownCmds)
  }, 10000)

  describe(`with user ${usr0} (authorized to get searches/allManagedData))`, () => {
    beforeAll(async () => {
      user = await getUserContext({ usr: usr0, ns })
    })

    test('should validate RBAC configuration for user', () => {
      expectCli(`oc auth can-i get searches --as=${user.fullName}`).not.toThrow()
      expectCli(`oc auth can-i list configmap --as=${user.fullName}`).toThrow()
    })

    test('should not receive ConfigMap', () => ValidateSearchData({ user, kind: 'configmap' }), validationTimeout)

    test(`should not match any resources containing the keyword 'cm0' or 'cm1`, async () => {
      const items = await resolveSearchItems(user.token, { keywords: ['cm0', 'cm1'] })
      expect(items).toHaveLength(0)
      expect(items).toEqual([])
    })
  })
})
