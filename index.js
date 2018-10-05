const util = require('util');
const exec = util.promisify(require('child_process').exec);
const crypto = require('crypto');
const fs = require('fs');
const AWS = require('aws-sdk');
const sequest = require('sequest');
const serializeError = require('serialize-error');

const CLOUDFORMATION_OPTIONS = {
  apiVersion: '2010-05-15',
  maxRetries: 11,
  retryDelayOptions: {
    /*
    | retryCount | sleep in s | maxRetries |
    | ---------- | ---------- | ---------- |
    | 0          | 1          | 1          |
    | 1          | 2          | 2          |
    | 2          | 4          | 3          |
    | 3          | 8          | 4          |
    | 4          | 16         | 5          |
    | 5          | 32         | 6          |
    | 6          | 64         | 7          |
    | 7          | 128        | 8          |
    | 8          | 256        | 9          |
    | 9          | 512        | 10         |
    | 10         | 1024       | 11         |
    */
    customBackoff: (retryCount) => Math.pow(2, retryCount) * 1000
  }
};

const EC2_OPTIONS = {
  apiVersion: '2016-11-15'
};

const createClient = async (service, options = {}) => {
  return new AWS[service](options);
};

const getCfnPackageBucketName = async () => {
  const env = 'CFN_PACKAGE_BUCKET_NAME';
  if (env in process.env) {
    return process.env[env];
  } else {
    throw new Error(`environment variable ${env} not set`);
  }
};

const package = async (templateFile, packagedFile) => {
  const cfnPackageBucketName = await getCfnPackageBucketName();
  const command = `aws cloudformation package --template-file ${templateFile} --s3-bucket ${cfnPackageBucketName} --output-template-file ${packagedFile}`;
  const {stdout, stderr} = await exec(command);
  return `${command}:\n${stderr}${stdout}`;
};

const deploy = async (packagedFile, stackName, parameters, capabilities) => {
  const cfnPackageBucketName = await getCfnPackageBucketName();
  let command = `aws cloudformation deploy --template-file ${packagedFile} --stack-name '${stackName}' --s3-bucket ${cfnPackageBucketName}`;
  if (Object.keys(parameters).length > 0) {
    command += ` --parameter-overrides ${Object.keys(parameters).map((parameterKey) => `'${parameterKey}=${parameters[parameterKey]}'`).join(' ')}`;
  }
  if (capabilities.length > 0) {
    command += ` --capabilities ${capabilities.join(' ')}`;
  }
  const {stdout, stderr} = await exec(command);
  return `${command}:\n${stderr}${stdout}`;
};

const packageAndDeploy = async (templateFile, stackName, parameters, capabilities) => {
  const packagedFile = `/tmp/${stackName}`;
  try {
    const out1 = await package(templateFile, packagedFile);
    const out2 = await deploy(packagedFile, stackName, parameters, capabilities);
    return `${out1}${out2}`;
  } finally {
    try {
      fs.unlinkSync(packagedFile);
    } catch (e) {
      // do nothing
    }
  }
};

const sleep = async (ms) => new Promise((resolve) => {
  setTimeout(() => {
    resolve();
  }, ms);
});

const retry = async (fn, tries = 30, delay = 10000) => {
  const errors = [];
  for (const i of Array(tries).fill().map((v, i) => i)) {
    try {
      return await fn();
    } catch (err) {
      err.message = `try[${i}]: ${err.message}`;
      errors.push(err);
      await sleep(delay);
    }
  }
  throw new Error(`retry failed: ${errors.map((err) => JSON.stringify(serializeError(err))).join('\n')}`);
};
exports.retry = retry;

exports.probeSSH = async (connect, key, command = 'uptime') => {
  return retry(() => new Promise((resolve, reject) => {
    sequest(connect, {
      privateKey: key.private,
      command: command
    }, (err, stdout) => {
      if (err) {
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  }));
};

exports.createKey = async (keyName) => {
  const ec2 = await createClient('EC2', EC2_OPTIONS);
  const data = await ec2.createKeyPair({KeyName: keyName}).promise();
  return {
    name: keyName,
    private: data.KeyMaterial
  };
}; 

exports.deleteKey = async (keyName) => {
  const ec2 = await createClient('EC2', EC2_OPTIONS);
  return await ec2.deleteKeyPair({KeyName: keyName}).promise();
};

exports.stackName = () => `cfn-test-${crypto.randomBytes(8).toString('hex')}`;

exports.keyName = () => `cfn-test-${crypto.randomBytes(8).toString('hex')}`;

exports.createStack = async (templateFile, stackName, parameters) => {
  return await packageAndDeploy(templateFile, stackName, parameters, ['CAPABILITY_IAM']);
};

exports.getStackOutputs = async (stackName) => {
  const cloudformation = await createClient('CloudFormation', CLOUDFORMATION_OPTIONS);
  const data = await cloudformation.describeStacks({StackName: stackName}).promise();
  if (data.Stacks.length !== 1) {
    throw new Error(`expected one stack, saw ${data.Stacks.length}`);
  } else {
    return data.Stacks[0].Outputs.reduce((outputs, output) => {
      outputs[output.OutputKey] = output.OutputValue;
      return outputs;
    }, {});
  }
};

exports.deleteStack = async (stackName) => {
  const cloudformation = await createClient('CloudFormation', CLOUDFORMATION_OPTIONS);
  await cloudformation.deleteStack({StackName: stackName}).promise();
  await cloudformation.waitFor('stackDeleteComplete', {StackName: stackName}).promise();
  return `AWS.CloudFormation().deleteStack(${stackName})\nAWS.CloudFormation().waitFor(stackDeleteComplete, ${stackName})\n`;
};
