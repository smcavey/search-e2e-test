// Copyright Contributors to the Open Cluster Management project

jest.retryTimes(global.retry, { logErrorsBeforeRetry: true })

const { execSync } = require('child_process')

const squad = require('../../config').get('squadName')

const testNamespace = 'search-webhook-test'

// Helper to apply a CollectorConfig YAML and return { success, output }.
function applyCollectorConfig(spec) {
  const yaml = `
apiVersion: search.open-cluster-management.io/v1alpha1
kind: CollectorConfig
metadata:
  name: webhook-test
  namespace: ${testNamespace}
spec:
${spec}`

  try {
    const output = execSync(`echo '${yaml}' | oc apply -f - 2>&1`, { encoding: 'utf-8' })
    return { success: true, output: output.trim() }
  } catch (e) {
    return { success: false, output: e.stderr ? e.stderr.trim() : e.stdout ? e.stdout.trim() : e.message }
  }
}

function deleteCollectorConfig() {
  try {
    execSync(`oc delete collectorconfig webhook-test -n ${testNamespace} --ignore-not-found=true 2>&1`, {
      encoding: 'utf-8',
    })
  } catch {
    // Ignore errors on cleanup.
  }
}

describe(`[P2][Sev2][${squad}] CollectorConfig webhook validation`, () => {
  beforeAll(() => {
    execSync(`oc create namespace ${testNamespace} --dry-run=client -o yaml | oc apply -f - 2>&1`, {
      encoding: 'utf-8',
    })
  })

  afterEach(() => {
    deleteCollectorConfig()
  })

  afterAll(() => {
    deleteCollectorConfig()
    try {
      execSync(`oc delete namespace ${testNamespace} --ignore-not-found=true 2>&1`, { encoding: 'utf-8' })
    } catch {
      // Ignore errors on cleanup.
    }
  })

  test('should reject a rule with empty apiGroups', () => {
    const result = applyCollectorConfig(`
  collectionRules:
    - action: include
      resourceSelector:
        apiGroups: []
        kinds:
          - Pod`)

    expect(result.success).toBe(false)
    expect(result.output).toContain('must specify at least one apiGroup')
  })

  test('should reject a rule with empty kinds', () => {
    const result = applyCollectorConfig(`
  collectionRules:
    - action: include
      resourceSelector:
        apiGroups:
          - ""
        kinds: []`)

    expect(result.success).toBe(false)
    expect(result.output).toContain('must specify at least one kind')
  })

  test('should reject a field with an invalid jsonPath', () => {
    const result = applyCollectorConfig(`
  collectionRules:
    - action: include
      resourceSelector:
        apiGroups:
          - apps
        kinds:
          - Deployment
      fields:
        - name: replicas
          jsonPath: "spec.replicas"`)

    expect(result.success).toBe(false)
    expect(result.output).toContain('must be a valid JSONPath expression')
  })

  test('should accept a valid include rule with fields', () => {
    const result = applyCollectorConfig(`
  collectionRules:
    - action: include
      resourceSelector:
        apiGroups:
          - apps
        kinds:
          - Deployment
      fields:
        - name: replicas
          jsonPath: "{.spec.replicas}"
          type: number`)

    expect(result.success).toBe(true)
  })

  test('should accept a valid exclude rule', () => {
    const result = applyCollectorConfig(`
  collectionRules:
    - action: exclude
      resourceSelector:
        apiGroups:
          - ""
        kinds:
          - Secret
          - ConfigMap`)

    expect(result.success).toBe(true)
  })
})
