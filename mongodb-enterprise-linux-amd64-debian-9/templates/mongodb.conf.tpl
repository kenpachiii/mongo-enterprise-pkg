# mongod.conf
# for documentation of all options, see:
#   http://docs.mongodb.org/manual/reference/configuration-options/

# Where and how to store data.
storage:
  dbPath: {{$app.dataDir}}/db
  journal:
    enabled: true
  directoryPerDB: {{enableDirectoryPerDB}}

# where to write logging data.
systemLog:
  destination: file
  quiet: {{disableSystemLog}}
  logAppend: true
  logRotate: reopen
  path: {{$app.logsDir}}/mongodb.log
  verbosity: {{$app.systemLogVerbosity}}

# network interfaces
net:
  port: {{$app.mongodbPort}}
  unixDomainSocket:
    enabled: true
    pathPrefix: {{$app.tmpDir}}
  ipv6: {{enableIPv6}}
  bindIpAll: true

# replica set options
#replication:
  #replSetName: {{$app.replicaSetName}}
  #enableMajorityReadConcern: true

# process management options
processManagement:
   fork: false
   pidFilePath: {{$app.pidFile}}

# set parameter options
setParameter:
   enableLocalhostAuthBypass: true

# security options
security:
  authorization: disabled
  #keyFile: replace_me
