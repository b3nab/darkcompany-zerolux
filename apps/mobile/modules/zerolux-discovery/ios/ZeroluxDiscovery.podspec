Pod::Spec.new do |s|
  s.name           = 'ZeroluxDiscovery'
  s.version        = '0.0.1'
  s.summary        = 'Finds ZeroLux kernels on the local network with Bonjour'
  s.description    = 'Finds ZeroLux kernels on the local network with Bonjour'
  s.license        = 'MIT'
  s.author         = 'Dark Company'
  s.homepage       = 'https://github.com/darkcompany/zerolux'
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
