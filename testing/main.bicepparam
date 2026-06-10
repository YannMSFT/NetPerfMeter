using './main.bicep'

param appBaseName = 'pipemeter'
param sku = 'B1'
param linuxFxVersion = 'NODE|20-lts'
param rootDomain = 'qik.fr'
param appDnsLabel = 'pipemeter'
param locations = [
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
