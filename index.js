const util = require('util');
const exec = util.promisify(require('child_process').exec);
const crypto = require('crypto');
const fs = require('fs');
const AWS = require('aws-sdk');
const sequest = require('sequest');
const serializeError = require('serialize-error');
const axios = require('axios');

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
    customBackoff: (retryCount) => 1 + Math.random() * Math.pow(2, retryCount) * 1000
  }
};

const EC2_OPTIONS = {
  apiVersion: '2016-11-15'
};

const S3_OPTIONS = {
  apiVersion: '2006-03-01'
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
  while (errors.length < tries) {
    try {
      return await fn();
    } catch (err) {
      errors.push({
        date: new Date(),
        err
      });
      await sleep(delay);
    }
  }
  throw new Error(`retry failed: ${errors.map((error, i) => `try[${(i+1)} | ${error.date.toISOString()}]: ${JSON.stringify(serializeError(error.err))}`).join('\n')}`);
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

exports.probeHttpGet = async (url) => {
  return retry(() => {
    return axios.get(url)
      .catch(err => {
        if (err.response && err.response.status) {
          return Promise.reject(new Error(`saw http status code ${err.response.status}`));
        } else {
          return Promise.reject(err);
        }
      });
  });
};

exports.probeHttpPost = async (url) => {
  return retry(() => {
    return axios.post(url)
      .catch(err => {
        if (err.response && err.response.status) {
          return Promise.reject(new Error(`saw http status code ${err.response.status}`));
        } else {
          return Promise.reject(err);
        }
      });
  });
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

exports.createObject = async (bucketName, objectKey, filePath) => {
  const fileData = fs.readFileSync(filePath);
  const s3 = await createClient('S3', S3_OPTIONS);
  return await s3.putObject({
    Bucket: bucketName,
    Key: objectKey,
    Body: fileData
  }).promise();
};

exports.deleteObject = async (bucketName, objectKey) => {
  const s3 = await createClient('S3', S3_OPTIONS);
  return await s3.deleteObject({
    Bucket: bucketName,
    Key: objectKey
  }).promise();
};

exports.emptyBucket = async (bucketName) => {
  const s3 = await createClient('S3', S3_OPTIONS);
  let continuationToken = undefined;
  while(continuationToken !== null) {
    const data = await s3.listObjectsV2({
      Bucket: bucketName,
      MaxKeys: 1000, // up to 1000
      ContinuationToken: continuationToken
    }).promise();
    if (data.Contents.length > 0) {
      await s3.deleteObjects({
        Bucket: bucketName,
        Delete: {
          Objects: data.Contents.map((content) => ({Key: content.Key}))
        }
      }).promise();
    }
    if (data.IsTruncated === true) {
      continuationToken = data.NextContinuationToken;
    } else {
      continuationToken = null;
    }
  }
};

exports.stackName = () => `cfn-test-${crypto.randomBytes(8).toString('hex')}`;

exports.keyName = () => `cfn-test-${crypto.randomBytes(8).toString('hex')}`;

exports.createStack = async (templateFile, stackName, parameters) => {
  return await packageAndDeploy(templateFile, stackName, parameters, ['CAPABILITY_IAM']);
};

exports.awaitStack = async (stackName) => {
  const WAIT_IN_SECONDS = 45;
  const MAX_WAIT_TIME_IN_MILLIS = 45 * 60 * 1000;
  const cloudformation = await createClient('CloudFormation', CLOUDFORMATION_OPTIONS);
  const waitForStackExistsStarted = Date.now();
  await cloudformation.waitFor('stackExists', {
    StackName: stackName,
    '$waiter': {
      delay: WAIT_IN_SECONDS,
      maxAttempts: Math.ceil(MAX_WAIT_TIME_IN_MILLIS / 1000 / WAIT_IN_SECONDS)
    }}).promise();
  const waitForStackExistsEnded = Date.now();
  const waitForStackDurationInMillis = waitForStackExistsEnded - waitForStackExistsStarted;
  const maxWaitTimeInSeconds = Math.max(WAIT_IN_SECONDS, Math.round((MAX_WAIT_TIME_IN_MILLIS - waitForStackDurationInMillis) / 1000));
  await cloudformation.waitFor('stackCreateComplete', {
    StackName: stackName,
    '$waiter': {
      delay: WAIT_IN_SECONDS,
      maxAttempts: Math.ceil(maxWaitTimeInSeconds / WAIT_IN_SECONDS)
    }}).promise();
  return `AWS.CloudFormation().waitFor(stackCreateComplete, ${stackName})\nAWS.CloudFormation().waitFor(stackCreateComplete, ${stackName})\n`;
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
  const WAIT_IN_SECONDS = 45;
  const MAX_WAIT_TIME_IN_SECONDS = 45 * 60;
  const cloudformation = await createClient('CloudFormation', CLOUDFORMATION_OPTIONS);
  await cloudformation.deleteStack({StackName: stackName}).promise();
  await cloudformation.waitFor('stackDeleteComplete', {
    StackName: stackName,
    '$waiter': {
      delay: WAIT_IN_SECONDS,
      maxAttempts: Math.ceil(MAX_WAIT_TIME_IN_SECONDS / WAIT_IN_SECONDS)
    }
  }).promise();
  return `AWS.CloudFormation().deleteStack(${stackName})\nAWS.CloudFormation().waitFor(stackDeleteComplete, ${stackName})\n`;
};
