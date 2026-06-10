@description('Name of the existing web app to bind the hostname to.')
param siteName string

@description('Fully-qualified custom hostname, e.g. westeurope.pipemeter.qik.fr.')
param hostname string

@description('Thumbprint of the issued managed certificate.')
param certificateThumbprint string

resource site 'Microsoft.Web/sites@2023-12-01' existing = {
  name: siteName
}

resource sniBinding 'Microsoft.Web/sites/hostNameBindings@2023-12-01' = {
  parent: site
  name: hostname
  properties: {
    siteName: siteName
    hostNameType: 'Verified'
    customHostNameDnsRecordType: 'CName'
    sslState: 'SniEnabled'
    thumbprint: certificateThumbprint
  }
}
