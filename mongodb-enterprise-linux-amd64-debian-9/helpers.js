'use strict';

const _ = require('lodash');
const componentFunctions = require('./lib/component')($app);
const networkFunctions = require('./lib/network')($app);
const utilsFunctions = require('./lib/utils');
const mongodbFunctions = require('./lib/databases').mongodb({
  binDir: $app.binDir,
  logger: utilsFunctions.getLoggerFromApp($app),
});

$app.helpers.validateInputs = function() {
  if ($app.replicaSetMode.match(/secondary|arbiter/) && _.isEmpty($app.primaryHost)) {
    throw new Error('In order to configure MongoDB as secondary or arbiter node '
                    + 'you need to provide the --primaryHost property');
  }
  const replicaSetAuthMessage = 'In order to configure MongoDB replica set authentication '
          + 'you need to provide the --replicaSetKey on every node, '
          + 'specify --rootPassword in the primary node and --primaryRootPassword in the rest of nodes';
  const replicaSetSlavesAuthProperties = [$app.primaryRootPassword, $app.replicaSetKey];
  if ($app.replicaSetMode.match(/secondary|arbiter/)) {
    if (!replicaSetSlavesAuthProperties.every(_.isEmpty) && replicaSetSlavesAuthProperties.some(_.isEmpty)) {
      throw new Error(replicaSetAuthMessage);
    }
    if (!_.isEmpty($app.rootPassword)) throw new Error(replicaSetAuthMessage);
  }
  const replicaSetMasterAuthProperties = [$app.rootPassword, $app.replicaSetKey];
  if ($app.replicaSetMode.match(/primary/)) {
    if (!replicaSetMasterAuthProperties.every(_.isEmpty) && replicaSetMasterAuthProperties.some(_.isEmpty)) {
      throw new Error(replicaSetAuthMessage);
    }
    if (!_.isEmpty($app.primaryRootPassword)) throw new Error(replicaSetAuthMessage);
  }
};

$app.helpers.configure = function(confProperties) {
  _.each(confProperties, (value, key) => {
    $file.substitute(
      $app.confFile,
      new RegExp(`#?${key}:.*`),
      `${key}: ${value}`,
      {type: 'regexp', abortOnUnmatch: true, global: false}
    );
  });
};


$app.helpers.enableAuth = function() {
  if ((!_.isEmpty($app.rootPassword) || !_.isEmpty($app.password)) && $app.configFileProvider === 'nami') {
    if (!$file.contains($app.confFile, /^[\s]*authorization: disabled/)) {
      $app.info('==> Enabling authentication...');
      const confProperties = {
        authorization: 'enabled',
        enableLocalhostAuthBypass: 'false',
      };
      this.configure(confProperties);
    }
  } else if ((!_.isEmpty($app.rootPassword) || !_.isEmpty($app.password)) && $app.configFileProvider === 'external') {
    $app.warn('==> You are mounting a configuration file and setting the mongodb password or root password.');
    $app.warn('==> Remember to enable authentication in your config file for those password to be valid.');
  }
};

$app.helpers.createUser = function() {
  if (!_.isEmpty($app.rootPassword) && !$app.replicaSetMode.match(/secondary|arbiter/)) {
    $app.info('==> Creating root user...');
    mongodbFunctions.createUser('root', $app.rootPassword, 'admin', 'root', {port: $app.mongodbPort});
  }
  $app.helpers.enableAuth();
  if (!_.isEmpty($app.username)) {
    if (!_.isEmpty($app.password) && !_.isEmpty($app.database)) {
      const commandOptions = {user: 'root', port: $app.mongodbPort};
      if (!_.isEmpty($app.rootPassword)) commandOptions.password = $app.rootPassword;
      $app.info(`==> Creating ${$app.username} user...`);
      mongodbFunctions.createUser(
        $app.username,
        $app.password,
        $app.database,
        {role: 'readWrite', db: $app.database},
        commandOptions
      );
    } else {
      throw new Error('If you defined an username you must define a password and a database too');
    }
  } else if (!_.isEmpty($app.password) || !_.isEmpty($app.database)) {
    throw new Error('If you defined a password or a database you should define an username too');
  }
};

$app.helpers.enableReplicaSetMode = function(replicaSetProperties) {
  $app.info('==> Enabling MongoDB replica set name');
  if ($app.configFileProvider === 'nami') {
    this.configure({
      replication: '',
      replSetName: replicaSetProperties.name,
      enableMajorityReadConcern: replicaSetProperties.enableMajorityReadConcern,
    });
  }
};

$app.helpers.configureReplicaSet = function(replicaSetProperties, connectionProperties) {
  $app.info('==> Configuring MongoDB replica set');
  this.enableReplicaSetMode(replicaSetProperties);
  const node = $app.advertisedHostname || networkFunctions.getMachineIp();
  $app.restart();
  switch (replicaSetProperties.mode) {
    case 'primary': {
      this.configurePrimary(node, _.assign({}, connectionProperties, {host: '127.0.0.1', port: $app.mongodbPort}));
      break;
    }
    case 'secondary': {
      this.configureSecondary(node, connectionProperties);
      break;
    }
    case 'arbiter': {
      this.configureArbiter(node, connectionProperties);
      break;
    }
    case 'dynamic': {
      // Do nothing
      break;
    }
    default: {
      throw new Error('Invalid replica set mode. Available options are \'primary/secondary/arbiter\'');
    }
  }
  // Don't stop secondary nodes before they are fully synced, or they might end up corrupt
  if ($app.replicaSetMode === 'secondary') {
    $app.helpers.waitUntilSyncComplete();
  }
};

$app.helpers.configurePrimary = function(node, connectionProperties) {
  $app.info('==> Configuring MongoDB primary node');
  networkFunctions.waitForService('127.0.0.1', $app.mongodbPort);
  const cfg = JSON.stringify({
    _id: $app.replicaSetName,
    members: [{_id: 0, host: `${node}:${$app.mongodbPort}`, priority: 5}],
  });
  const isPrimaryNodeInitiated = function() {
    const streams = mongodbFunctions.execute(`rs.initiate(${cfg})`, connectionProperties);
    const isPending = !_.includes(streams.stdout, '"ok" : 1');
    return isPending;
  };
  // T27642 We need to retry this function because it may fail
  $util.retryWhile(isPrimaryNodeInitiated, {timeout: 90, step: 5});
};

$app.helpers.configureSecondary = function(node, connectionProperties) {
  $app.info('==> Configuring MongoDB secondary node');
  this.waitForPrimaryNode(connectionProperties);
  const isSecondaryNodePending = function() {
    const streams = mongodbFunctions.execute(`rs.add('${node}:${$app.mongodbPort}')`, connectionProperties);
    const isPending = !_.includes(streams.stdout, '"ok" : 1');
    return isPending;
  };
  // We need to retry this function because the primary node could not be running
  $util.retryWhile(isSecondaryNodePending, {timeout: 90, step: 5});
  // We also need to wait a confirmation from the primary so the secondary knows that has been added to replica set
  this.waitConfirmation(node, connectionProperties);
};

$app.helpers.configureArbiter = function(node, connectionProperties) {
  $app.info('==> Configuring MongoDB arbiter node');
  this.waitForPrimaryNode(connectionProperties);
  const isArbiterNodePending = function() {
    const streams = mongodbFunctions.execute(`rs.addArb('${node}:${$app.mongodbPort}')`, connectionProperties);
    const isPending = !_.includes(streams.stdout, '"ok" : 1');
    return isPending;
  };
  // We need to retry this function because the primary node could not be running
  $util.retryWhile(isArbiterNodePending, {timeout: 90, step: 5});
  // We also need to wait a confirmation from the primary so the arbiter knows that has been added to replica set
  this.waitConfirmation(node, connectionProperties);
};

$app.helpers.waitForPrimaryNode = function(connectionProperties) {
  $app.debug('Waiting for primary node...');
  mongodbFunctions.checkConnection({
    user: $app.primaryRootUser,
    password: $app.primaryRootPassword,
    database: 'admin',
    host: $app.primaryHost,
    port: $app.primaryPort,
  });
  const isPrimaryNodeUp = function() {
    try {
      $app.debug(`==> Validating ${$app.primaryHost} as primary node...`);
      const streams = mongodbFunctions.execute('db.isMaster().ismaster', connectionProperties);
      const isPrimaryUp = _.isEqual(streams.stdout, 'true');
      return isPrimaryUp;
    } catch (err) {
      $app.debug(`[isPrimaryNodeUp] ERROR: ${err}`);
      return false;
    }
  };
  $app.trace(`[waitForPrimaryNode] Waiting for primary to be ready`);
  if (!$util.retryWhile(isPrimaryNodeUp, {timeout: 90, step: 5})) {
    throw new Error(`Unable to validate ${$app.primaryHost} as primary node in the replica set scenario`);
  }
};

$app.helpers.waitConfirmation = function(node, connectionProperties) {
  const isNodeConfirmed = function() {
    try {
      const streams = mongodbFunctions.execute('rs.status().members', connectionProperties);
      const isNodePresent = !_.includes(streams.stdout, node);
      return isNodePresent;
    } catch (err) {
      $app.trace(`[isNodeConfirmed] ERROR: ${err}`);
      return false;
    }
  };
  $app.trace(`[waitConfirmation] Waiting until ${node} is added to the replica set`);
  if (!$util.retryWhile(isNodeConfirmed, {timeout: 90, step: 5})) {
    throw new Error(`Unable to confirm that ${node} has been added to the replica set`);
  }
};

$app.helpers.configureKeyFile = function(keyFile, key, user) {
  $app.info('==> Writing keyfile for replica set authentication');
  try {
    $file.write(keyFile, key);
  } catch (e) {
    throw new Error(`Unable to write key in ${keyFile}: ${e}`);
  }
  this.configureKeyFilePermissions(keyFile, user);
  if ($app.configFileProvider === 'nami') {
    this.configure({authorization: 'enabled', keyFile: keyFile});
  }
};

$app.helpers.configureKeyFilePermissions = function(keyFile, user) {
  componentFunctions.configurePermissions([{
    path: keyFile, user: user, mod: '400',
  }]);
};

$app.helpers.populatePrintProperties = function() {
  const properties = {};
  if (!$app.replicaSetMode.match(/secondary|arbiter|dynamic/)) {
    properties['Root Password'] = $app.rootPassword;
  }
  if ($app.username && $app.password && $app.database) {
    properties.Username = $app.username;
    properties.Password = $app.password;
    properties.Database = $app.database;
  }

  if (!_.isEmpty($app.replicaSetMode)) {
    properties['Replication Mode'] = $app.replicaSetMode;
    if ($app.replicaSetMode.match(/secondary|arbiter/)) {
      properties['Primary Host'] = $app.primaryHost;
      properties['Primary Port'] = $app.primaryPort;
      properties['Primary Root User'] = $app.primaryRootUser;
      properties['Primary Root Password'] = $app.primaryRootPassword;
    }
  }
  return properties;
};

$app.helpers.waitUntilSyncComplete = function(options) {
  options = _.defaults(options || {}, {timeout: 10});
  let timeoutCounter = 0;
  let logContents;
  let syncComplete = false;
  $app.info('==> Waiting until initial data sync is complete');
  while (!syncComplete && (timeoutCounter += 1) <= options.timeout) {
    $util.sleep(1);
    logContents = $file.read($app.logFile);
    syncComplete = logContents.includes('initial sync done');
  }
  if (!syncComplete) {
    $app.info(`==> Initial data sync did not finish after ${options.timeout} seconds!`);
  }
};

$app.helpers.dropLocalDatabase = function() {
  $app.info('==> Drop local database to reset replica set setup');
  mongodbFunctions.execute(`db.getSiblingDB('local').dropDatabase()`);
};
