Package.describe({
  summary: "Common code for OAuth-based services",
  version: "1.0.0"
});

Package.on_use(function (api) {
  api.use('routepolicy', 'server');
  api.use('webapp', 'server');
  api.use('mongo-livedata', 'server');

  api.use(['underscore', 'service-configuration', 'logging'], 'server');

  api.use('oauth-encryption', 'server', {weak: true});

  api.use('localstorage');

  api.export('OAuth');
  api.export('OAuthTest', 'server', {testOnly: true});

  api.add_files('oauth_client.js', 'client');
  api.add_files('oauth_server.js', 'server');
  api.add_files('pending_credentials.js', 'server');

  api.add_files('end_of_login_response.html', 'server', { isAsset: true });

  api.add_files('oauth_common.js');

  // XXX COMPAT WITH 0.8.0
  api.export('Oauth');
  api.add_files('deprecated.js', ['client', 'server']);
});


Package.on_test(function (api) {
  api.use('tinytest');
  api.use('random');
  api.use('service-configuration', 'server');
  api.use('oauth', 'server');
  api.add_files("oauth_tests.js", 'server');
});
