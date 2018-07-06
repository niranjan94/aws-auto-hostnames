const AWS = require('aws-sdk');
const deepmerge = require('./deepmerge');

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

  zones = (await route53.listHostedZones().promise()).HostedZones.map(zone => ({
    id: zone.Id.split('/').pop(),
    name: zone.Name,
    domain: zone.Name.substring(0, zone.Name.length - 1)
  }));

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

  for (const instance of instances) {
    for (const hostname of instance.hostnames) {
      const zone = getClosestMatchingZone(hostname);
      if (!zone || (config.dns.ignoreZones || []).includes(zone.domain) || (config.dns.ignoreZones || []).includes(zone.id)) {
        continue;
      }
      zoneUpdateChanges[zone.id] = zoneUpdateChanges[zone.id] || [];
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
        },
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

  for (const zoneId in zoneUpdateChanges) {
    if (zoneUpdateChanges.hasOwnProperty(zoneId) && zoneUpdateChanges[zoneId].length > 0) {
      const changes = zoneUpdateChanges[zoneId];
      await route53.changeResourceRecordSets({
        HostedZoneId: zoneId,
        ChangeBatch: {
          Changes: changes
        }
      }).promise();
      console.log(`${changes.length} records modified in ${zoneId}`);
    }
  }
};