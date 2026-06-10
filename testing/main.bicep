@description('Base name used to build globally-unique web app and plan names. Must be lowercase, letters/numbers/hyphens.')
param appBaseName string = 'pipemeter'

@description('App Service plan SKU.')
param sku string = 'B1'

@description('Linux runtime stack for the web apps.')
param linuxFxVersion string = 'NODE|20-lts'

@description('Root domain used for custom hostnames, e.g. qik.fr.')
param rootDomain string = 'qik.fr'

@description('DNS label placed under the root domain, e.g. pipemeter -> <region>.pipemeter.qik.fr.')
param appDnsLabel string = 'pipemeter'

@description('Regions to deploy to. Each item gets its own App Service plan + web app.')
param locations array = [
  {
    region: 'northeurope'
    suffix: 'neu'
  }
  {
    region: 'westeurope'
    suffix: 'weu'
  }
  {
    region: 'francecentral'
    suffix: 'frc'
  }
  {
    region: 'eastus'
    suffix: 'eus'
  }
  {
    region: 'westus'
    suffix: 'wus'
  }
]

@description('Fully-qualified custom hostname for each region, e.g. westeurope.pipemeter.qik.fr.')
var hostnames = [for loc in locations: '${loc.region}.${appDnsLabel}.${rootDomain}']

resource plans 'Microsoft.Web/serverfarms@2023-12-01' = [for loc in locations: {
  name: '${appBaseName}-plan-${loc.suffix}'
  location: loc.region
  sku: {
    name: sku
  }
  kind: 'linux'
  properties: {
    reserved: true
  }
}]

resource sites 'Microsoft.Web/sites@2023-12-01' = [for (loc, i) in locations: {
  name: '${appBaseName}-${loc.suffix}'
  location: loc.region
  properties: {
    serverFarmId: plans[i].id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: linuxFxVersion
      webSocketsEnabled: true
      alwaysOn: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      http20Enabled: true
      appSettings: [
        {
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'true'
        }
        {
          name: 'WEBSITE_NODE_DEFAULT_VERSION'
          value: '~20'
        }
      ]
    }
  }
}]

resource scmBasicAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = [for (loc, i) in locations: {
  parent: sites[i]
  name: 'scm'
  properties: {
    allow: true
  }
}]

// Pass 1: bind the custom hostname without SSL so the managed certificate can be issued for it.
resource hostBindings 'Microsoft.Web/sites/hostNameBindings@2023-12-01' = [for (loc, i) in locations: {
  parent: sites[i]
  name: hostnames[i]
  properties: {
    siteName: sites[i].name
    hostNameType: 'Verified'
    customHostNameDnsRecordType: 'CName'
    sslState: 'Disabled'
  }
}]

// App Service managed certificate (free) for each custom hostname.
resource certs 'Microsoft.Web/certificates@2023-12-01' = [for (loc, i) in locations: {
  name: 'cert-${loc.suffix}-${appDnsLabel}'
  location: loc.region
  properties: {
    serverFarmId: plans[i].id
    canonicalName: hostnames[i]
    domainValidationMethod: 'cname-delegation'
  }
  dependsOn: [
    hostBindings[i]
  ]
}]

// Pass 2: re-bind the hostname with SNI SSL using the issued certificate thumbprint.
module sniBindings 'modules/sni-enable.bicep' = [for (loc, i) in locations: {
  name: 'sni-${loc.suffix}'
  params: {
    siteName: sites[i].name
    hostname: hostnames[i]
    certificateThumbprint: certs[i].properties.thumbprint
  }
}]

output webAppHosts array = [for (loc, i) in locations: sites[i].properties.defaultHostName]
output webAppNames array = [for (loc, i) in locations: sites[i].name]
output customHostnames array = hostnames
// DNS the user must create: a CNAME from each customHostname to its cnameTarget,
// plus a TXT record asuid.<customHostname> set to the domainVerificationId.
output cnameTargets array = [for (loc, i) in locations: sites[i].properties.defaultHostName]
output domainVerificationIds array = [for (loc, i) in locations: sites[i].properties.customDomainVerificationId]
