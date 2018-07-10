const util = require('util');
const exec = util.promisify(require('child_process').exec);
const crypto = require('crypto');
const fs = require('fs');
const AWS = require('aws-sdk');

const createClient = async (service, options = {}) => {
  return new AWS[service](options);
};

const package = async (templateFile, packagedFile) => {
  const command = `aws cloudformation package --template-file ${templateFile} --s3-bucket mwittig-cfn-modules --output-template-file ${packagedFile}`;
  const {stdout, stderr} = await exec(command);
  return `${command}:\n${stderr}${stdout}`;
};
const deploy = async (packagedFile, stackName, parameters, capabilities) => {
  let command = `aws cloudformation deploy --template-file ${packagedFile} --stack-name '${stackName}' --s3-bucket mwittig-cfn-modules`;
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
    fs.unlinkSync(packagedFile);
  }
};

/*
exports.probeSSH = async (host, key) => {}; // TODO implement

exports.createKey = async (keyName) => {}; // TODO implement
exports.deleteKey = async (keyName) => {}; // TODO implement
*/

exports.stackName = () => `cfn-test-${crypto.randomBytes(8).toString('hex')}`;
exports.createStack = async (templateFile, stackName, parameters) => {
  return await packageAndDeploy(templateFile, stackName, parameters, ['CAPABILITY_IAM']);
};
exports.getStackOutputs = async (stackName) => {
  const cloudformation = await createClient('CloudFormation', {apiVersion: '2010-05-15'});
  const data = await cloudformation.describeStacks({StackName: stackName}).promise();
  if (data.Stacks.length !== 1) {
    throw new Error(`expected one stack, saw ${data.Stacks.length}`);
  } else {
    return data.Stacks[0].Outputs.reduce((options, option) => {
      options[option.OutputKey] = option.OutputValue;
    }, {});
  }
};
exports.deleteStack = async (stackName) => {
  const cloudformation = await createClient('CloudFormation', {apiVersion: '2010-05-15'});
  await cloudformation.deleteStack({StackName: stackName}).promise();
  await cloudformation.waitFor('stackDeleteComplete', {StackName: stackName}).promise();
  return `AWS.CloudFormation().deleteStack(${stackName})\nAWS.CloudFormation().waitFor(stackDeleteComplete, ${stackName})\n`;
};
