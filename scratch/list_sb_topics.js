const { ServiceBusAdministrationClient } = require("@azure/service-bus");
require('dotenv').config();

async function main() {
    const connectionString = process.env.SERVICE_BUS_CONNECTION_STRING;
    if (!connectionString) {
        console.error("SERVICE_BUS_CONNECTION_STRING not found in .env");
        return;
    }

    const adminClient = new ServiceBusAdministrationClient(connectionString);

    try {
        console.log("Fetching topics...");
        const topics = adminClient.listTopics();
        let found = false;
        for await (const topic of topics) {
            found = true;
            console.log(`- Topic: ${topic.name}`);
            
            // List subscriptions for each topic
            const subs = adminClient.listSubscriptions(topic.name);
            for await (const sub of subs) {
                const runtime = await adminClient.getSubscriptionRuntimeProperties(topic.name, sub.subscriptionName);
                console.log(`  - Subscription: ${sub.subscriptionName} (Active: ${runtime.activeMessageCount}, DLQ: ${runtime.deadLetterMessageCount})`);
            }
        }
        if (!found) console.log("No topics found in this namespace.");
    } catch (err) {
        console.error("Error listing topics:", err.message);
    }
}

main();
