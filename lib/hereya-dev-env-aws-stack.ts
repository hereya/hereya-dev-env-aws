import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export class HereyaDevEnvAwsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Input parameters
    const instanceType = process.env['instanceType'] || 't3.medium';
    const vpcId: string | undefined = process.env['vpcId'];
    const sshCidr = process.env['sshCidr'] || '0.0.0.0/0';
    const volumeSizeGb = parseInt(process.env['volumeSize'] || '50', 10);
    const hereyaToken: string | undefined = process.env['hereyaToken'];
    const hereyaCloudUrl: string = process.env['hereyaCloudUrl'] || 'https://cloud.hereya.dev';

    // New parameters for on-demand lifecycle and idle stop
    const lifecycle = process.env['lifecycle'] || 'on-demand';
    const idleStopMinutes = parseInt(process.env['idleStopMinutes'] || '30', 10);
    const connectionIdleBps = parseInt(process.env['connectionIdleBps'] || '100', 10);
    const ownerUserId = process.env['ownerUserId'];

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

    // IAM role with SSM for Session Manager fallback + CloudFormation signal
    const role = new iam.Role(this, 'DevEnvRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    // Allow instance to describe its own stack and signal CloudFormation
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        'cloudformation:DescribeStackResource',
        'cloudformation:SignalResource',
      ],
      resources: ['*'],
    }));

    // Allow instance to push logs to CloudWatch
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'logs:DescribeLogStreams',
      ],
      resources: ['*'],
    }));

    // EC2 Key Pair — private key auto-stored in SSM Parameter Store at /ec2/keypair/{keyPairId}
    const keyPair = new ec2.KeyPair(this, 'DevEnvKeyPair', {
      keyPairName: `${this.stackName}-dev-env-key`,
    });

    // Build the setup script content
    const setupLines = [
      '#!/bin/bash',
      'set -ex',
      'exec > >(tee /var/log/hereya-dev-env-setup.log) 2>&1',
      '',
      '# System updates and git',
      'dnf update -y',
      'dnf install -y git cronie',
      '',
      '# Install Node.js 22 via NodeSource',
      'curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -',
      'dnf install -y nodejs',
      '',
      '# Install Claude Code globally',
      'npm install -g @anthropic-ai/claude-code',
      '',
      '# Install Hereya CLI globally',
      'npm install -g hereya-cli',
      '',
      '# Install AWS CDK globally',
      'npm install -g aws-cdk',
      '',
      '# Install Docker',
      'dnf install -y docker',
      'systemctl enable docker',
      'systemctl start docker',
      'usermod -aG docker ec2-user',
      '',
      '# Install cloudflared for tunneling',
      'curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-x86_64.rpm -o /tmp/cloudflared.rpm',
      'dnf install -y /tmp/cloudflared.rpm',
      'rm -f /tmp/cloudflared.rpm',
    ];

    // Login to Hereya Cloud if token provided
    if (hereyaToken) {
      setupLines.push(
        '',
        '# Login to Hereya Cloud',
        `sudo -u ec2-user hereya login --token=${hereyaToken} ${hereyaCloudUrl}`,
      );
    }

    setupLines.push(
      '',
      '# Verify installations',
      'node --version',
      'npm --version',
      'claude --version || true',
      'hereya --version || true',
      'cdk --version',
      '',
      '# Make global npm packages available to ec2-user',
      "grep -q '/usr/lib/node_modules/.bin' /home/ec2-user/.bashrc || echo 'export PATH=/usr/lib/node_modules/.bin:$PATH' >> /home/ec2-user/.bashrc",
    );

    // Hereya CLI auto-update: hourly cron
    setupLines.push(
      '',
      '# Hereya CLI auto-update cron',
      "cat > /opt/hereya/update-hereya.sh << 'UPDATEEOF'",
      '#!/bin/bash',
      'exec 200>/var/lock/hereya-update.lock',
      'flock -n 200 || exit 0',
      'LOG_TAG="hereya-update"',
      'log() {',
      '  echo "$(date \'+%Y-%m-%d %H:%M:%S\') $1" | tee -a /var/log/hereya-update.log',
      '  logger -t "$LOG_TAG" "$1"',
      '}',
      "CURRENT=$(hereya --version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' || echo '0.0.0')",
      "LATEST=$(npm view hereya-cli version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+')",
      'if [ -z "$LATEST" ]; then',
      '  log "ERROR: Failed to fetch latest version from npm"',
      '  exit 1',
      'fi',
      'if [ "$CURRENT" = "$LATEST" ]; then',
      '  log "hereya-cli is up to date ($CURRENT)"',
      '  exit 0',
      'fi',
      'log "Updating hereya-cli from $CURRENT to $LATEST"',
      'if npm install -g hereya-cli@latest 2>&1 | tee -a /var/log/hereya-update.log; then',
      "  INSTALLED=$(hereya --version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+')",
      '  log "Update successful: now running $INSTALLED"',
      'else',
      '  log "ERROR: npm install failed"',
      '  exit 1',
      'fi',
      'UPDATEEOF',
      'chmod +x /opt/hereya/update-hereya.sh',
      '',
      '# Schedule hourly update check at minute 17',
      'echo "17 * * * * root /opt/hereya/update-hereya.sh" > /etc/cron.d/hereya-update',
      'chmod 644 /etc/cron.d/hereya-update',
    );

    // Idle activity tracker — only when idleStopMinutes > 0
    if (idleStopMinutes > 0) {
      setupLines.push(
        '',
        '# Idle activity tracker — per-:22-connection byte rate',
        '# State files live on tmpfs (/run) so they reset on every boot. EBS-persisted',
        '# state caused a wake -> immediate self-stop loop because the streak counter',
        '# survived the previous shutdown and was already at the limit.',
        'mkdir -p /run/hereya',
        "cat > /opt/hereya/check-activity.sh <<'CHKEOF'",
        '#!/bin/bash',
        'set -u',
        `IDLE_BPS=${connectionIdleBps}`,
        `IDLE_LIMIT=${idleStopMinutes}`,
        'STATE=/run/hereya/conn-state.tsv',
        'STREAK=/run/hereya/idle-streak',
        'GRACE_SECONDS=300',
        '',
        '# Boot grace period: do nothing for the first GRACE_SECONDS after boot,',
        '# so a freshly-woken instance has time for the user to actually connect',
        '# before the idle clock starts ticking.',
        'mkdir -p /run/hereya',
        'UPTIME=$(awk \'{print int($1)}\' /proc/uptime)',
        'if [ "$UPTIME" -lt "$GRACE_SECONDS" ]; then',
        '  exit 0',
        'fi',
        '',
        'IMDS_TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300" || echo "")',
        '[ -z "$IMDS_TOKEN" ] && exit 0',
        'INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id)',
        'REGION=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/placement/region)',
        'NOW=$(date +%s)',
        '',
        '# Build a temp state file. ss -tinH outputs one connection per pair of lines (header line + TCP_INFO line)',
        'TMP=$(mktemp)',
        'ACTIVE=0',
        "ss -tinH state established '( sport = :22 )' 2>/dev/null | awk -v now=$NOW '",
        '  /^[A-Z]/ {',
        '    # Connection summary line — last whitespace-separated field is peer',
        '    peer=$NF;',
        '    next',
        '  }',
        '  /bytes_sent/ {',
        '    snt=0; rcv=0',
        '    for (i=1; i<=NF; i++) {',
        '      if (match($i, /^bytes_sent:([0-9]+)/, a)) snt=a[1]',
        '      if (match($i, /^bytes_received:([0-9]+)/, b)) rcv=b[1]',
        '    }',
        '    print peer "\\t" snt "\\t" rcv "\\t" now',
        '  }',
        "' > \"$TMP\"",
        '',
        '# For each connection in TMP, look up prior in STATE and compute rate',
        'while IFS=$\'\\t\' read -r peer snt rcv ts; do',
        '  prev=$(grep -F "${peer}\t" "$STATE" 2>/dev/null | tail -1)',
        '  if [ -n "$prev" ]; then',
        '    psnt=$(echo "$prev" | cut -f2)',
        '    prcv=$(echo "$prev" | cut -f3)',
        '    pts=$(echo "$prev" | cut -f4)',
        '    elapsed=$((ts - pts))',
        '    [ "$elapsed" -lt 1 ] && elapsed=1',
        '    delta=$(( (snt - psnt) + (rcv - prcv) ))',
        '    rate=$(( delta / elapsed ))',
        '    if [ "$rate" -ge "$IDLE_BPS" ]; then',
        '      ACTIVE=$((ACTIVE + 1))',
        '    fi',
        '  else',
        '    # First sighting — give it the benefit of the doubt',
        '    ACTIVE=$((ACTIVE + 1))',
        '  fi',
        'done < "$TMP"',
        '',
        '# Replace state atomically',
        'mv "$TMP" "$STATE"',
        '',
        '# Publish metric (best-effort)',
        'aws cloudwatch put-metric-data \\',
        '  --namespace HereyaDevEnv \\',
        '  --metric-name ActiveSshConnections \\',
        '  --value "$ACTIVE" \\',
        '  --dimensions InstanceId="$INSTANCE_ID" \\',
        '  --region "$REGION" >/dev/null 2>&1 || true',
        '',
        '# Self-stop logic',
        'if [ "$ACTIVE" -eq 0 ]; then',
        '  CUR=$(cat "$STREAK" 2>/dev/null || echo 0)',
        '  CUR=$((CUR + 1))',
        '  echo "$CUR" > "$STREAK"',
        '  if [ "$CUR" -ge "$IDLE_LIMIT" ]; then',
        '    logger -t hereya-idle "Idle for $CUR consecutive minutes; stopping instance"',
        '    aws ec2 stop-instances --instance-ids "$INSTANCE_ID" --region "$REGION" >/dev/null 2>&1 || true',
        '  fi',
        'else',
        '  echo 0 > "$STREAK"',
        'fi',
        'CHKEOF',
        'chmod +x /opt/hereya/check-activity.sh',
        '',
        '# Cron entry',
        'echo "* * * * * root /opt/hereya/check-activity.sh" > /etc/cron.d/hereya-activity',
        'chmod 644 /etc/cron.d/hereya-activity',
      );
    }

    const setupScript = setupLines.join('\n');

    // CloudWatch agent config to stream setup logs
    const cwAgentConfig = {
      logs: {
        logs_collected: {
          files: {
            collect_list: [
              {
                file_path: '/var/log/cfn-init.log',
                log_group_name: `/hereya/dev-env/${this.stackName}`,
                log_stream_name: 'cfn-init',
              },
              {
                file_path: '/var/log/hereya-dev-env-setup.log',
                log_group_name: `/hereya/dev-env/${this.stackName}`,
                log_stream_name: 'setup',
              },
              {
                file_path: '/var/log/hereya-update.log',
                log_group_name: `/hereya/dev-env/${this.stackName}`,
                log_stream_name: 'hereya-update',
              },
            ],
          },
        },
      },
    };

    // Log group with auto-cleanup
    new logs.LogGroup(this, 'DevEnvLogGroup', {
      logGroupName: `/hereya/dev-env/${this.stackName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // CloudFormation::Init configuration
    const cfnInit = ec2.CloudFormationInit.fromConfigSets({
      configSets: {
        default: ['cloudwatch', 'setup'],
      },
      configs: {
        // CloudWatch agent: install and start before setup so logs are captured
        cloudwatch: new ec2.InitConfig([
          ec2.InitPackage.yum('amazon-cloudwatch-agent'),
          ec2.InitFile.fromString(
            '/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json',
            JSON.stringify(cwAgentConfig, null, 2),
          ),
          ec2.InitCommand.shellCommand(
            '/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json',
            { key: '01-start-cw-agent' },
          ),
        ]),
        // Main setup: write and execute the provisioning script
        setup: new ec2.InitConfig([
          ec2.InitFile.fromString('/opt/hereya/setup.sh', setupScript, {
            mode: '000755',
            owner: 'root',
            group: 'root',
          }),
          ec2.InitCommand.shellCommand('/opt/hereya/setup.sh', {
            key: '01-run-setup',
          }),
        ]),
      },
    });

    const [instClass, instSize] = instanceType.split('.');

    // Single EC2 instance with CloudFormation::Init
    const instance = new ec2.Instance(this, 'DevEnvInstance', {
      vpc,
      instanceType: ec2.InstanceType.of(
        instClass as ec2.InstanceClass,
        instSize as ec2.InstanceSize,
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: sg,
      role,
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
      init: cfnInit,
      initOptions: {
        configSets: ['default'],
        timeout: cdk.Duration.minutes(30),
      },
    });

    // Tag the instance so IAM policies can scope by tag instead of by instance ID
    // (referencing instance.instanceId in resource ARNs creates a circular dep
    // between the instance, its role, and the role's policy).
    cdk.Tags.of(instance).add('hereya:devenv-stack', this.stackName);

    // IAM additions for the instance role when idle stop is enabled
    if (idleStopMinutes > 0) {
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'cloudwatch:namespace': 'HereyaDevEnv' },
        },
      }));
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['ec2:StopInstances'],
        resources: [`arn:aws:ec2:${this.region}:${this.account}:instance/*`],
        conditions: {
          StringEquals: { 'ec2:ResourceTag/hereya:devenv-stack': this.stackName },
        },
      }));
    }

    // On-demand wake broker (Lambda + API Gateway + Authorizer)
    if (lifecycle === 'on-demand') {
      if (!ownerUserId) {
        throw new Error('ownerUserId is required when lifecycle=on-demand');
      }

      // Authorizer Lambda — verifies the caller's hereya-cloud access token
      // against the verify-token endpoint and gates by recorded owner userId.
      const authorizerFn = new lambda.Function(this, 'DevEnvAuthorizerFn', {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'index.handler',
        timeout: cdk.Duration.seconds(10),
        environment: {
          OWNER_USER_ID: ownerUserId,
          HEREYA_VERIFY_URL: `${hereyaCloudUrl}/api/auth/verify-token`,
        },
        code: lambda.Code.fromInline(`
const crypto = require('crypto');

let cache = new Map(); // tokenHash -> { userId, expiresAt }
const CACHE_TTL_MS = 60_000;

exports.handler = async (event) => {
  try {
    const headers = event.headers || {};
    const auth = headers.authorization || headers.Authorization || '';
    const m = /^Bearer\\s+(.+)$/.exec(auth);
    if (!m) return { isAuthorized: false };
    const token = m[1];

    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const now = Date.now();
    let entry = cache.get(hash);

    if (!entry || entry.expiresAt < now) {
      const r = await fetch(process.env.HEREYA_VERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!r.ok) return { isAuthorized: false };
      const body = await r.json();
      if (!body || body.valid !== true) return { isAuthorized: false };
      entry = { userId: body.userId, expiresAt: now + CACHE_TTL_MS };
      cache.set(hash, entry);

      // Cap cache size — drop oldest entries when over 256.
      if (cache.size > 256) {
        const firstKey = cache.keys().next().value;
        if (firstKey !== undefined) cache.delete(firstKey);
      }
    }

    return { isAuthorized: entry.userId === process.env.OWNER_USER_ID };
  } catch (err) {
    console.error('authorizer error', err);
    return { isAuthorized: false };
  }
};
`),
      });

      // Broker Lambda
      const brokerEnv: { [k: string]: string } = {
        INSTANCE_ID: instance.instanceId,
        REGION: this.region,
      };

      const brokerFn = new lambda.Function(this, 'DevEnvBrokerFn', {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'index.handler',
        timeout: cdk.Duration.seconds(15),
        environment: brokerEnv,
        code: lambda.Code.fromInline(`
const { EC2Client, DescribeInstancesCommand, StartInstancesCommand, StopInstancesCommand } = require('@aws-sdk/client-ec2');

const ec2 = new EC2Client({ region: process.env.REGION });

async function describe() {
  const r = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [process.env.INSTANCE_ID] }));
  const inst = r.Reservations && r.Reservations[0] && r.Reservations[0].Instances && r.Reservations[0].Instances[0];
  if (!inst) return { state: 'unknown', host: '', lastTransitionAt: new Date().toISOString() };
  const state = inst.State && inst.State.Name || 'unknown';
  const host = inst.PublicIpAddress || '';
  const lastTransitionAt = inst.StateTransitionReason || new Date().toISOString();
  return { state, host, lastTransitionAt };
}

function reply(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || event.httpMethod || '';
  const path = (event.requestContext && event.requestContext.http && event.requestContext.http.path) || event.rawPath || event.path || '';
  try {
    if (method === 'POST' && path.endsWith('/wake')) {
      const desc = await describe();
      if (desc.state === 'stopped' || desc.state === 'stopping') {
        await ec2.send(new StartInstancesCommand({ InstanceIds: [process.env.INSTANCE_ID] }));
        return reply(200, { state: 'pending', host: '' });
      }
      return reply(200, { state: desc.state, host: desc.host });
    }
    if (method === 'POST' && path.endsWith('/sleep')) {
      await ec2.send(new StopInstancesCommand({ InstanceIds: [process.env.INSTANCE_ID] }));
      return reply(200, { state: 'stopping' });
    }
    if (method === 'GET' && path.endsWith('/status')) {
      const desc = await describe();
      return reply(200, desc);
    }
    return reply(404, { error: 'not_found' });
  } catch (e) {
    console.error('broker error', e);
    return reply(500, { error: 'internal_error', message: String(e && e.message || e) });
  }
};
`),
      });

      // IAM for broker — scope by tag, not by instance ARN, to avoid the same
      // circular dep that bit the instance role.
      brokerFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['ec2:StartInstances', 'ec2:StopInstances'],
        resources: [`arn:aws:ec2:${this.region}:${this.account}:instance/*`],
        conditions: {
          StringEquals: { 'ec2:ResourceTag/hereya:devenv-stack': this.stackName },
        },
      }));
      brokerFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['ec2:DescribeInstances'],
        resources: ['*'],
      }));

      // HTTP API + authorizer
      const httpApi = new apigwv2.HttpApi(this, 'DevEnvHttpApi', {
        apiName: `${this.stackName}-dev-env-wake`,
      });

      const authorizer = new HttpLambdaAuthorizer('DevEnvAuthorizer', authorizerFn, {
        responseTypes: [HttpLambdaResponseType.SIMPLE],
      });

      const brokerIntegration = new HttpLambdaIntegration('DevEnvBrokerIntegration', brokerFn);

      httpApi.addRoutes({
        path: '/wake',
        methods: [apigwv2.HttpMethod.POST],
        integration: brokerIntegration,
        authorizer,
      });
      httpApi.addRoutes({
        path: '/sleep',
        methods: [apigwv2.HttpMethod.POST],
        integration: brokerIntegration,
        authorizer,
      });
      httpApi.addRoutes({
        path: '/status',
        methods: [apigwv2.HttpMethod.GET],
        integration: brokerIntegration,
        authorizer,
      });

      // Initial-stop custom resource — fires only on create
      const initialStop = new cr.AwsCustomResource(this, 'DevEnvInitialStop', {
        onCreate: {
          service: 'EC2',
          action: 'stopInstances',
          parameters: {
            InstanceIds: [instance.instanceId],
          },
          physicalResourceId: cr.PhysicalResourceId.of(`${this.stackName}-initial-stop`),
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['ec2:StopInstances'],
            resources: [`arn:aws:ec2:${this.region}:${this.account}:instance/*`],
            conditions: {
              StringEquals: { 'ec2:ResourceTag/hereya:devenv-stack': this.stackName },
            },
          }),
        ]),
      });
      initialStop.node.addDependency(instance);

      new cdk.CfnOutput(this, 'devEnvWakeUrl', {
        value: httpApi.apiEndpoint,
        description: 'HTTP API endpoint for the on-demand wake broker',
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

    // Informational outputs (always emitted)
    new cdk.CfnOutput(this, 'devEnvLifecycle', {
      value: lifecycle,
      description: 'Lifecycle mode (always-on or on-demand)',
    });
    new cdk.CfnOutput(this, 'devEnvIdleStopMinutes', {
      value: String(idleStopMinutes),
      description: 'Consecutive idle minutes before self-stop (0 disables)',
    });
    new cdk.CfnOutput(this, 'devEnvConnectionIdleBps', {
      value: String(connectionIdleBps),
      description: 'Per-connection bytes/sec threshold for idle detection',
    });
  }
}
