const AWS = require('aws-sdk');
const deepmerge = require('./deepmerge');
const {table} = require('table');
const _ = require('lodash');
const colors = require('colors/safe');

function log(message) {
  console.log(colors.green(`[${new Date().toISOString()}] ${message}`));
}

let config = {
  aws: {
    region: 'ap-southeast-1'
  },
  dns: {
    ttl: 300
  }
};

try {
  const overrideConfig = require('./config');
  config = deepmerge(config, overrideConfig);
} catch (e) {
  // Ignore if not config.json is available
}

AWS.config.update({
  region: config.aws.region
});

let instances = [];
let zones = [];
let clusterHostnames = {};

function getClosestMatchingZone(hostname) {
  let lastMatchingZone = null;
  for (const zone of zones) {
    if (hostname.endsWith(zone.domain) && (!lastMatchingZone || lastMatchingZone.domain.length <= zone.domain.length)) {
      lastMatchingZone = zone;
    }
  }
  return lastMatchingZone;
}

exports.handler = async () => {
  const ec2 = new AWS.EC2();
  const route53 = new AWS.Route53();

  const params = {
    Filters: [
      {
        Name: 'tag-key',
        Values: ['hostnames']
      },
      {
        Name: 'instance-state-name',
        Values: ['running']
      }
    ]
  };

  log('Querying existing hosted zones.');

  zones = (await route53.listHostedZones().promise()).HostedZones.map(zone => ({
    id: zone.Id.split('/').pop(),
    name: zone.Name,
    domain: zone.Name.substring(0, zone.Name.length - 1)
  }));

  log('Querying EC2 Instances.');

  const data = await ec2.describeInstances(params).promise();

  for (const reservation of data.Reservations) {
    for (const instance of reservation.Instances) {
      instances.push({
        id: instance.InstanceId,
        hostnames: instance.Tags.find(tag => tag.Key === 'hostnames').Value.split(',').map(s => s.trim()),
        privateIp: instance.PrivateIpAddress,
        publicIp: instance.PublicIpAddress
      });
    }
  }

  const zoneUpdateChanges = {};
  log('Generating DNS update set.');

  for (const instance of instances) {
    for (const hostname of instance.hostnames) {
      const zone = getClosestMatchingZone(hostname);
      if (!zone || (config.dns.ignoreZones || []).includes(zone.domain) || (config.dns.ignoreZones || []).includes(zone.id)) {
        continue;
      }

      const clusterMatched = hostname.match(/\d{4}.(.+)/);

      if (clusterMatched && clusterMatched.length >= 2) {
        const clusterHostName = clusterMatched[1];

        clusterHostnames[clusterHostName] = clusterHostnames[clusterHostName] || {
          zoneId: zone.id,
          privateIps: [],
          publicIps: []
        };

        clusterHostnames[clusterHostName].privateIps.push(instance.privateIp);

        if (instance.publicIp) {
          clusterHostnames[clusterHostName].publicIps.push(instance.publicIp);
        }
      }

      zoneUpdateChanges[zone.id] = zoneUpdateChanges[zone.id] || [];

      if (instance.publicIp) {
        zoneUpdateChanges[zone.id].push(
          {
            Action: 'UPSERT',
            ResourceRecordSet: {
              Name: hostname,
              ResourceRecords: [
                {
                  Value: instance.publicIp
                }
              ],
              TTL: config.dns.ttl,
              Type: 'A'
            }
          }
        );
      }

      zoneUpdateChanges[zone.id].push(
        {
          Action: 'UPSERT',
          ResourceRecordSet: {
            Name: `private.${hostname}`,
            ResourceRecords: [
              {
                Value: instance.privateIp
              }
            ],
            TTL: config.dns.ttl,
            Type: 'A'
          }
        }
      );
    }
  }

  for (const clusterHostname in clusterHostnames) {
    if (clusterHostnames.hasOwnProperty(clusterHostname)) {
      const zoneId = clusterHostnames[clusterHostname].zoneId;

      zoneUpdateChanges[zoneId] = zoneUpdateChanges[zoneId] || [];

      if (clusterHostnames[clusterHostname].publicIps && clusterHostnames[clusterHostname].publicIps.length > 0) {
        zoneUpdateChanges[zoneId].push(
          {
            Action: 'UPSERT',
            ResourceRecordSet: {
              Name: clusterHostname,
              ResourceRecords: clusterHostnames[clusterHostname].publicIps.map(ip => ({
                Value: ip
              })),
              TTL: config.dns.ttl,
              Type: 'A'
            }
          }
        );
      }

      zoneUpdateChanges[zoneId].push(
        {
          Action: 'UPSERT',
          ResourceRecordSet: {
            Name: `private.${clusterHostname}`,
            ResourceRecords: clusterHostnames[clusterHostname].privateIps.map(ip => ({
              Value: ip
            })),
            TTL: config.dns.ttl,
            Type: 'A'
          }
        }
      );
    }
  }

  const tableData = [
    [colors.bold('Zone'), colors.bold('Hostname'), colors.bold('Type'), colors.bold('TTL'), colors.bold('Resource')]
  ];

  for (const zoneId in zoneUpdateChanges) {
    if (zoneUpdateChanges.hasOwnProperty(zoneId) && zoneUpdateChanges[zoneId].length > 0) {
      const changes = zoneUpdateChanges[zoneId];

      log(`[${zoneId}] Querying existing resource record set.`);

      const existingRecords = (await route53.listResourceRecordSets({
        HostedZoneId: zoneId,
        StartRecordName: 'a',
        StartRecordType: 'A'
      }).promise()).ResourceRecordSets.filter(it => it.Type === 'A');

      log(`[${zoneId}] Generating resource record set diff.`);

      const changesDiff = [];

      for (const change of changes) {
        const oldEntry = _.find(existingRecords, ['Name', change.ResourceRecordSet.Name + '.']);
        if (oldEntry) {
          if (
            _.sortBy(oldEntry.ResourceRecords.map(it => it.Value)).join(',') !==
            _.sortBy(change.ResourceRecordSet.ResourceRecords.map(it => it.Value)).join(',')) {
            changesDiff.push(change);
          }
        } else {
          changesDiff.push(change);
        }
      }

      tableData.push(
        ...changesDiff.map(
          it => [
            zoneId,
            it.ResourceRecordSet.Name,
            it.ResourceRecordSet.Type,
            it.ResourceRecordSet.TTL,
            it.ResourceRecordSet.ResourceRecords.map(it => it.Value).join(',')
          ]
        )
      );

      if (process.env.DRY_RUN === 'false' && changesDiff.length > 0) {
        log(`[${zoneId}] Applying resource record sets.`);

        await route53.changeResourceRecordSets({
          HostedZoneId: zoneId,
          ChangeBatch: {
            Changes: changesDiff
          }
        }).promise();

        log(`[${zoneId}] Applied ${changesDiff.length} resource record sets ✓`);
      }
    }
  }

  if (tableData.length > 1) {
    console.log('');
    console.log('Changes Summary');
    console.log('===============');
    console.log('');

    console.log(table(tableData));
  }
};