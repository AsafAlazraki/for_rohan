// scripts/publish-test.js
require('dotenv').config();
const { ServiceBusClient } = require('@azure/service-bus');
const crypto = require('crypto');

async function sendTest() {
  const connStr = process.env.SERVICE_BUS_CONNECTION_STRING;
  const topic = process.env.DAPR_TOPIC_DYNAMICS || 'dynamics-contacts';
  if (!connStr) throw new Error('SERVICE_BUS_CONNECTION_STRING is required');
  const sbClient = new ServiceBusClient(connStr);
  const sender = sbClient.createSender(topic);

  const payload = { contactid: 'GUID-1', firstname: 'Alice', lastname: 'Smith', emailaddress1: 'alice@example.com' };
  const payloadStr = JSON.stringify(payload);
  const secret = process.env.DYNAMICS_WEBHOOK_SECRET;
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(Buffer.from(payloadStr, 'utf8')).digest('hex');

  await sender.sendMessages({
    body: payload,
    applicationProperties: {
      'x-dynamics-signature': sig
    }
  });

  await sender.close();
  await sbClient.close();
  console.log('Message published');
}

sendTest().catch(err => { console.error(err); process.exit(1); });
