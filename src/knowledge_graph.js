// src/knowledge_graph.js
function buildKnowledgeGraph(worldData) {
    const graph = {
        nodes: new Map(), // Master index of all objects by _id
        edges: []         // Relationships (e.g., actor -> item)
    };

    // 1. Index everything
    for (const cat in worldData) {
        worldData[cat].forEach(item => {
            if (item._id) graph.nodes.set(item._id, item);
        });
    }

    // 2. Discover links (Logic to find IDs inside objects)
    graph.nodes.forEach(node => {
        // Foundry stores item IDs in an 'items' array on actors
        if (node.items && Array.isArray(node.items)) {
            node.items.forEach(item => {
                const targetId = item._id || item; // Handle both objects and ID strings
                graph.edges.push({ from: node._id, to: targetId, type: 'inventory' });
            });
        }
    });
    
    return graph;
}

module.exports = { buildKnowledgeGraph };