#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { HereyaDevEnvAwsStack } from '../lib/hereya-dev-env-aws-stack';

const app = new cdk.App();
new HereyaDevEnvAwsStack(app, process.env.STACK_NAME!, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
