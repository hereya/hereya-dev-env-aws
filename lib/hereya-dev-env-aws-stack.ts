import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export class HereyaDevEnvAwsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Input parameters
    const instanceType = process.env['instanceType'] || 't3.medium';
    const vpcId: string | undefined = process.env['vpcId'];
    const sshCidr = process.env['sshCidr'] || '0.0.0.0/0';
    const volumeSizeGb = parseInt(process.env['volumeSize'] || '50', 10);
    const domain: string | undefined = process.env['domain'];
    const hereyaToken: string | undefined = process.env['hereyaToken'];
    const hereyaCloudUrl: string = process.env['hereyaCloudUrl'] || 'https://cloud.hereya.dev';

    // VPC
    const vpc = vpcId
      ? ec2.Vpc.fromLookup(this, 'Vpc', { vpcId })
      : ec2.Vpc.fromLookup(this, 'Vpc', { isDefault: true });

    // Security group — SSH inbound, all outbound
    const sg = new ec2.SecurityGroup(this, 'DevEnvSG', {
      vpc,
      description: 'Hereya dev environment - SSH access',
      allowAllOutbound: true,
    });
    sg.addIngressRule(
      ec2.Peer.ipv4(sshCidr),
      ec2.Port.tcp(22),
      'SSH access',
    );

    // IAM role with SSM for Session Manager fallback
    const role = new iam.Role(this, 'DevEnvRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // EC2 Key Pair — private key auto-stored in SSM Parameter Store at /ec2/keypair/{keyPairId}
    const keyPair = new ec2.KeyPair(this, 'DevEnvKeyPair', {
      keyPairName: `${this.stackName}-dev-env-key`,
    });

    // UserData script
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -ex',

      // Log all output for debugging
      'exec > >(tee /var/log/hereya-dev-env-userdata.log) 2>&1',

      // System updates and git
      'dnf update -y',
      'dnf install -y git',

      // Install Node.js 22 via NodeSource
      'curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -',
      'dnf install -y nodejs',

      // Install Claude Code globally
      'npm install -g @anthropic-ai/claude-code',

      // Install Hereya CLI globally
      'npm install -g hereya-cli',

      // Install AWS CDK globally
      'npm install -g aws-cdk',

      // Install Docker
      'dnf install -y docker',
      'systemctl enable docker',
      'systemctl start docker',
      'usermod -aG docker ec2-user',

      // Install cloudflared for tunneling
      'curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-x86_64.rpm -o /tmp/cloudflared.rpm',
      'dnf install -y /tmp/cloudflared.rpm',
      'rm -f /tmp/cloudflared.rpm',
    );

    // Login to Hereya Cloud if token provided
    if (hereyaToken) {
      userData.addCommands(
        `sudo -u ec2-user hereya login --token=${hereyaToken} ${hereyaCloudUrl}`,
      );
    }

    userData.addCommands(
      // Verify installations
      'node --version',
      'npm --version',
      'claude --version || true',
      'hereya --version || true',
      'cdk --version',

      // Make global npm packages available to ec2-user
      'echo \'export PATH=/usr/lib/node_modules/.bin:$PATH\' >> /home/ec2-user/.bashrc',
    );

    const [instClass, instSize] = instanceType.split('.');

    // Single EC2 instance
    const instance = new ec2.Instance(this, 'DevEnvInstance', {
      vpc,
      instanceType: ec2.InstanceType.of(
        instClass as ec2.InstanceClass,
        instSize as ec2.InstanceSize,
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: sg,
      role,
      userData,
      keyPair,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      associatePublicIpAddress: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(volumeSizeGb, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
    });

    // Optional Route53 DNS record: <stackName>.<domain>
    if (domain) {
      const zone = route53.HostedZone.fromLookup(this, 'Zone', { domainName: domain });
      new route53.ARecord(this, 'DevEnvDns', {
        zone,
        recordName: `${this.stackName}.${domain}`,
        target: route53.RecordTarget.fromIpAddresses(instance.instancePublicIp),
      });

      new cdk.CfnOutput(this, 'devEnvSshHostDns', {
        value: `${this.stackName}.${domain}`,
        description: 'DNS name of the dev environment instance',
      });
    }

    // Outputs
    new cdk.CfnOutput(this, 'devEnvSshHost', {
      value: instance.instancePublicIp,
      description: 'Public IP of the dev environment instance',
    });

    new cdk.CfnOutput(this, 'devEnvSshPrivateKey', {
      value: `arn:aws:ssm:${this.region}:${this.account}:parameter/ec2/keypair/${keyPair.keyPairId}`,
      description: 'SSM Parameter ARN for the SSH private key (auto-resolved by Hereya)',
    });

    new cdk.CfnOutput(this, 'devEnvSshUser', {
      value: 'ec2-user',
      description: 'SSH username',
    });

    new cdk.CfnOutput(this, 'devEnvSshKeyPairId', {
      value: keyPair.keyPairId,
      description: 'EC2 Key Pair ID',
    });

    new cdk.CfnOutput(this, 'devEnvSecurityGroupId', {
      value: sg.securityGroupId,
      description: 'Security group ID',
    });

    new cdk.CfnOutput(this, 'devEnvInstanceId', {
      value: instance.instanceId,
      description: 'EC2 Instance ID',
    });
  }
}
