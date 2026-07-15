// src/data_processor.js
const { getAllWorldData } = require('./data_manager');
const { buildKnowledgeGraph } = require('./knowledge_graph');

async function initializeGameContext() {
    console.log("-> Processing world data into knowledge graph...");
    const rawData = await getAllWorldData();
    const graph = buildKnowledgeGraph(rawData);
    
    console.log(`-> Graph ready with ${graph.nodes.size} nodes.`);
    return graph;
}

module.exports = { initializeGameContext };