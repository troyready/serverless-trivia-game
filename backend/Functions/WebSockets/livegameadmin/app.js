/*
  Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
  Permission is hereby granted, free of charge, to any person obtaining a copy of this
  software and associated documentation files (the "Software"), to deal in the Software
  without restriction, including without limitation the rights to use, copy, modify,
  merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
  permit persons to whom the Software is furnished to do so.
  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
  INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
  PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
  HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
  OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
  SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

// SPDX-License-Identifier: MIT-0

// Function: livegameadmin:app.js

/* eslint no-console: ["error", { allow: ["warn", "error"] }] */
/* eslint no-param-reassign: ["error",
  { "props": true, "ignorePropertyModificationsFor": ["gameInfo"] }] */
/* eslint no-case-declarations: "error" */

const AWS = require('aws-sdk');
const WSSend = require('/opt/index.js');

AWS.config.apiVersions = { dynamodb: '2012-08-10', sns: '2010-03-31', kinesis: '2013-12-02' };
AWS.config.update = ({ region: process.env.REGION });

const ddb = new AWS.DynamoDB.DocumentClient();
const sns = new AWS.SNS();
const kinesis = new AWS.Kinesis();

// const topicarn = process.env.SEND_CHAT_TOPIC_ARN;
const playerProgressTopic = process.env.PLAYER_PROGRESS_TOPIC;
const highscoreTableName = process.env.SCORES_TABLE_NAME;
const gamesTableName = process.env.GAMES_TABLE_NAME;
const playerInventoryTableName = process.env.PLAYER_INVENTORY_TABLE_NAME;
const playersTableName = process.env.PLAYERS_TABLE_NAME;
const questionsTableName = process.env.GAMES_DETAIL_TABLE_NAME;
const scoreStream = process.env.RESPONSE_STREAM;

function dateString() {
  const date = new Date();
  const dateStr = `${(`00${date.getMonth() + 1}`).slice(-2)}/${
    (`00${date.getDate()}`).slice(-2)}/${
    date.getFullYear()} ${
    (`00${date.getHours()}`).slice(-2)}:${
    (`00${date.getMinutes()}`).slice(-2)}:${
    (`00${date.getSeconds()}`).slice(-2)}`;

  return dateStr;
}

async function deleteItem(Table, Key) {
  const params = {
    TableName: Table,
    Key,
  };
  try {
    await ddb.delete(params).promise();
  } catch (err) {
    console.error(`Delete ERROR ${JSON.stringify(params)}`);
    return err;
  }
  return 1;
}

async function hostGame(gameInfo, connectionId, domainName, stage) {
  // store the game to be hosted
  const parms = {};
  delete gameInfo.subaction; //
  gameInfo.hostConnection = connectionId;
  parms.Item = gameInfo;
  parms.TableName = gamesTableName;
  const returnMessage = {};
  try {
    await ddb.put(parms).promise();
  } catch (e) {
    console.error(`could not store game: ${e}`);
    return { statusCode: 500, body: JSON.stringify({ data: e.stack }) };
  }
  const item = {};
  item.gameId = gameInfo.gameId;
  item.connectionId = connectionId;
  item.role = 'HOST';
  item.userName = gameInfo.playerName;
  parms.Item = item;
  parms.TableName = playersTableName;
  try {
    await ddb.put(parms).promise();
  } catch (e) {
    console.error(`Error hosting game ${JSON.stringify(e.stack)}`);
  }
  const pe = 'gameId,questionNumber,'
    + 'question, answerA, answerB, answerC, answerD, correctAnswer,'
    + 'questionGroup, alternatives, answerFollowup, questionURI, answerURI';
  // load question array for host
  const queryparms = {
    TableName: questionsTableName,
    ExpressionAttributeValues: { ':v1': gameInfo.gameId },
    ExpressionAttributeNames: { '#f1': 'gameId' },
    KeyConditionExpression: '#f1 = :v1',
    ProjectionExpression: pe,
  };
  const Key = { gameId: gameInfo.gameId, playerName: gameInfo.playerName };
  try {
    const questions = await ddb.query(queryparms).promise();
    returnMessage.question = questions.Items;
    returnMessage.channel = 'livestart';
    const quizHeader = await ddb.get({ TableName: playerInventoryTableName, Key }).promise();
    returnMessage.quizname = quizHeader.Item.quizName;
    returnMessage.gameId = quizHeader.Item.gameId;
    returnMessage.questionType = quizHeader.Item.questionType;
    returnMessage.quizMode = quizHeader.Item.quizMode;
    // returnMessage.questions = questionArray;
  } catch (e) {
    console.error(`quizHeader ${JSON.stringify(Key)}`);
    console.error(`Error getting game ${e}`);
    return { statusCode: 500, body: 'Looks like an invalid game' };
  }
  const message = {};
  // user, channel, message
  message.userName = gameInfo.playerName;
  message.channel = gameInfo.channel;
  message.action = 'chat';
  message.message = `Hosting game :${gameInfo.quizName}`;
  message.domainName = domainName;
  message.stage = stage;
  const val = WSSend.SendChat(message);
  return val;
}

async function sendMessages(analytics) {
  // TODO: Add to anayltics pipeline
  const Data = JSON.stringify({ playerName: analytics.playerName, gameId: analytics.gameId, 
    dateOfQuiz: dateString(), quizMode: analytics.quizMode, 
    questions: analytics.questions });
  let val = await kinesis.putRecord({Data, StreamName: scoreStream, PartitionKey: 'score001' }).promise(); 
  if(val.hasOwnProperty('SequenceNumber'))
    return { statusCode: 200, body: 'analytics sent' };
  else {
    console.error(`error writing to shard: ${JSON.stringify(val)} `);
    return { statusCode: 500, body: 'error sending to kinesis' };
  }
}

async function updateProgress(progress) {
  const parms = { Message: JSON.stringify(progress), TopicArn: playerProgressTopic };
  try {
    await sns.publish(parms).promise();
  } catch (e) {
    console.error(`Error with progress ${JSON.stringify(progress)}`);
    return { statusCode: 500, body: e.stack };
  }
  return 1;
}

async function deleteRecords(msg) {
  // delete records here if on reset
  // need to grab regular index
  const recsToDeleteParms = {
    TableName: playersTableName,
    ProjectionExpression: 'gameId, connectionId',
    KeyConditionExpression: '#f1 = :v1',
    ExpressionAttributeValues: { ':v1': msg.gameId },
    ExpressionAttributeNames: { '#f1': 'gameId' },
  };
  let deleteData;
  try {
    deleteData = await ddb.query(recsToDeleteParms).promise();
  } catch (e) {
    console.error(`error with getting delete ${JSON.stringify(recsToDeleteParms)}`);
    return { statusCode: 500, body: e.stack };
  }
  for (let i = 0; i < deleteData.Count; i += 1) {
    const parms = { gameId: msg.gameId, connectionId: deleteData.Items[i].connectionId };
    await deleteItem(playersTableName, parms);
  }
  const parms = { gameId: msg.gameId, playerName: msg.playerName };
  await deleteItem(gamesTableName, parms);
  return 1;
}

exports.handler = async (event) => {
  let message = {};
  let parms = {};
  let val = {statusCode: 400, message: "could not find switch"};
  message = JSON.parse(event.body).data;
  switch (message.subaction) {
    case 'hostgame':
      val = hostGame(message, event.requestContext.connectionId,
        event.requestContext.domainName, event.requestContext.stage);
      break;
    case 'scoreboardupdate':
      try {
        await ddb.put({ TableName: highscoreTableName, Item: message.item }).promise();
        val = { statusCode: 200, body: 'highscoredatasaved' };
      } catch (e) {
        const errString = 'error saving highscore data for '
          + `${JSON.stringify(message.item)} ${JSON.stringify(e)}`;
        console.error(errString);
        val = { statusCode: 500, body: e.stack };
      }
      break;
    case 'analytics':
      val = await sendMessages(message.analytics);
      break;
    case 'progress':
      await updateProgress(message.progress);
      val = { statusCode: 200, body: 'messages sent' };
      break;
    default:
      message.domainName = event.requestContext.domainName;
      message.stage = event.requestContext.stage;
      message.action = 'liveadmin';
      parms.Message = JSON.stringify(message);
      val = await WSSend.SendChat(message);
      if (message.subaction === 'reset') {
        await deleteRecords(message);
      }
      break;
  }
  return val;
};
