'use strict';

const _ = require('lodash');
const volumeFunctions = require('./lib/volume')($app);
const componentFunctions = require('./lib/component')($app);

$app.postUnpackFiles = function() {
  // Needed so we can call to $app.start and similar while initiasing as non-root
  $app.installedAsRoot = false;
};

$app.postInstallation = function() {
  $app.installedAsRoot = false;
  const keyFile = $file.join($app.confDir, 'keyfile');
  let user = null;
  let group = null;
  if ($os.runningAsRoot()) {
    user = $app.systemUser;
    group = $app.systemGroup;
    $os.addGroup(group);
    $os.addUser(user, {gid: group});
  }
  _.each([$app.tmpDir, $app.logsDir], function(folder) {
    $file.mkdir(folder, {owner: user, group: group});
  });
  const dbDir = $file.join($app.persistDir, 'data', 'db');
  if (!$file.exists(dbDir) || $file.isEmptyDir($file.join($app.persistDir, 'data', 'db'))) {
    $app.info('==> Deploying MongoDB from scratch...');

    $app.helpers.validateInputs();
    $file.mkdir($file.join($app.dataDir, 'db'), {owner: user});

    // If conf file not exists, generate the default one.
    if (!$file.exists($app.confFile)) {
      $app.info('==> No injected configuration files found. Creating default config files...');
      $hb.renderToFile(
        'mongodb.conf.tpl',
        $app.confFile,
        {
          enableIPv6: $app.enableIPv6 === 'yes' ? true : false,
          enableDirectoryPerDB: $app.enableDirectoryPerDB === 'yes' ? true : false,
          disableSystemLog: $app.disableSystemLog === 'yes' ? true : false,
        }
      );
    } else {
      $app.configFileProvider = 'external';
      $app.info('==> Configuration files found...');
    }
    $app.start();

    $app.helpers.createUser();
    if (!_.isEmpty($app.replicaSetMode)) {
      const connectionProperties = {
        host: $app.primaryHost,
        port: $app.primaryPort,
        database: 'admin',
        user: 'root',
        password: $app.primaryRootPassword || $app.rootPassword || '',
      };
      const replicaSetProperties = {
        name: $app.replicaSetName,
        mode: $app.replicaSetMode,
        enableMajorityReadConcern: $app.enableMajorityReadConcern === 'yes',
      };
      // https://docs.mongodb.com/manual/tutorial/deploy-replica-set-with-keyfile-access-control/
      if (!_.isEmpty($app.replicaSetKey)) $app.helpers.configureKeyFile(keyFile, $app.replicaSetKey, user);
      $app.helpers.configureReplicaSet(replicaSetProperties, connectionProperties);
    }
    $app.stop();
    // MongoDB recommends to place the database in a XFS filesystem.
    // Moving the data to the persistent volumes first,
    // which can be formatted to XFS, solves this.
    volumeFunctions.prepareDataToPersist($app.dataToPersist);
  } else {
    $app.info('==> Deploying MongoDB with persisted data...');
    volumeFunctions.restorePersistedData($app.dataToPersist);

    // If conf file not exists, generate the default one.
    if (!$file.exists($app.confFile)) {
      $app.info('==> No injected configuration files found. Creating default config files...');
      $hb.renderToFile(
        'mongodb.conf.tpl',
        $app.confFile,
        {
          enableIPv6: $app.enableIPv6 === 'yes' ? true : false,
          enableDirectoryPerDB: $app.enableDirectoryPerDB === 'yes' ? true : false,
          disableSystemLog: $app.disableSystemLog === 'yes' ? true : false,
        }
      );
    } else {
      $app.configFileProvider = 'external';
      $app.info('==> Configuration files found...');
    }
    if (!_.isEmpty($app.replicaSetMode)) {
      if ($app.replicaSetMode === 'dynamic' && !$file.contains(
        $app.confFile,
        new RegExp(`^\\s*replSetName: ${$app.replicaSetName}`, 'm')
      )) {
        $app.info('==> ReplicaSetMode set to "dynamic" and replSetName different from config file.');
        $app.info('==> Dropping local database ...');
        $app.start();
        $app.helpers.dropLocalDatabase();
        $app.stop();
      }

      const replicaSetProperties = {
        name: $app.replicaSetName,
        mode: $app.replicaSetMode,
        enableMajorityReadConcern: $app.enableMajorityReadConcern === 'yes',
      };
      if (!_.isEmpty($app.replicaSetKey)) $app.helpers.configureKeyFile(keyFile, $app.replicaSetKey);
      $app.helpers.enableReplicaSetMode(replicaSetProperties);
    }
    $app.helpers.enableAuth();
  }

  // Configuring permissions for tmp, logs and data folders
  if ($os.runningAsRoot()) {
    componentFunctions.configurePermissions([{
      path: [$app.tmpDir, $app.logsDir],
      user: $app.systemUser,
      group: $app.systemGroup,
    }]);
  }
  componentFunctions.configurePermissions([{
    path: [$app.dataDir],
    user: user,
    group: group,
    mod: {directory: '755', file: '644'},
  }]);

  componentFunctions.createExtraConfigurationFiles([
    {type: 'monit', path: $app.monitFile, params: {service: 'mongodb', pidFile: $app.pidFile}},
    {type: 'logrotate', path: $app.logrotateFile, params: {logPath: $file.join($app.logsDir, '*log')}},
  ]);
  componentFunctions.printProperties($app.helpers.populatePrintProperties());
};
