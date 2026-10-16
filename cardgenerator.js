// Canvas Setup
const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const ctx = canvas.getContext('2d');


// Calculate Card Dimensions
const screenHeight = window.innerHeight;
const cardHeight = 0.4 * screenHeight; // 40% of screen height
const cardWidth = (2.5 / 3.5) * cardHeight;
const cornerRadius = 0.1 * Math.min(cardWidth, cardHeight); // 10% of smaller dimension

// Adjust Canvas Size
canvas.width = 2*cardWidth+20;
canvas.height = cardHeight+20;


function drawCard(x,y,value, suit, color) {
    ctx.translate(x, y); // Move origin to (x, y)

    ctx.clearRect(0, 0, cardWidth, cardHeight);

    // Draw Rounded Rectangle (Card)
    ctx.beginPath();
    ctx.roundRect(0, 0, cardWidth, cardHeight, cornerRadius);
    ctx.fillStyle = "white";
    ctx.fill();
    ctx.strokeStyle = "black";
    ctx.stroke();

    // Determine Suit Symbol and Font Size
    let symbol, fontSize = 100;
    switch (suit) {
        case "heart": symbol = "♥"; break;
        case "spade": symbol = "♠"; 
            if (value === "1") {
                value = "A";
                fontSize *= 3; // Make Ace of Spades larger
            }
            break;
        case "club": symbol = "♣"; break;
        case "diamond": symbol = "♦"; break;
        case "moon": symbol = "☪"; break;
        case "star": symbol = "★"; break;
        case "snowflake": symbol = "𖤓"; break;
        case "clover":  symbol = "☘"; break; // New suit
        case "cross":   symbol = "✝"; break; // New suit
        case "skull":   symbol = "☠"; break; // New suit
        case "flower":  symbol = "᪥"; break; // New suit
        default:
            return; // Invalid suit
    }

    



    // Draw Suit Symbol (Middle)
    if (value === "J" || value === "Q" || value === "K") {
        // Face Card: Suit Next to Letter
        let temp = value;
        value = value + symbol;
        fontSize *= 1.5; // Make face card symbol larger

            // Handle Face Card Symbols and Sizing
        if (temp === "J") {
            symbol = "♘";
        } else if (temp === "Q") {
            symbol = "♕";
        } else if (temp === "K") {
            symbol = "♔";
        }
    }

    ctx.font = `bold ${fontSize}px Arial`;
    ctx.fillStyle = color;


    // drawing patterns for the number cards
    let symbolCount = parseInt(value); // Convert value to number if it's a number card
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    if (!isNaN(symbolCount) && symbolCount >= 2 && symbolCount <= 10){
        drawSymbolsOnCard(symbolCount, symbol, color, cardWidth, cardHeight); // Draw symbols in pattern
    }
    else{
    //  Suit in Middle/ face in the middle
  
    ctx.fillText(symbol, cardWidth / 2, cardHeight / 2);}

    // Draw Value (Top Left)
    ctx.font = "bold 40px Arial"; // Reset font size for value
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(value, 10, 10); 

    // Draw Value (Bottom Right, Upside Down)
    ctx.save();
    ctx.translate(cardWidth, cardHeight);
    ctx.rotate(Math.PI);
    ctx.fillText(value, 10, 10);
    ctx.restore();

    ctx.translate(-x, -y); // Reset origin
}

function drawSymbolsOnCard(count, suit, color, width, height) {
    const margin = 20; // Adjust for spacing from edges
    const symbolSize = 2* Math.min((width - 2 * margin) / 5, (height - 2 * margin) / 2); // Calculate max symbol size

    console.log(width, height, margin)

    ctx.fillStyle = color;
    ctx.font = `${symbolSize}px Arial`;

    const positions = getSymbolPositions(count, width, height, symbolSize, margin);
    for (const pos of positions) {
        ctx.fillText(suit, pos.x, pos.y);
    }
}

function getSymbolPositions(count, width, height, symbolSize, margin) {
    const positions = [];
    const centerX = width / 2;
    const centerY = height / 2;
    const spacing = symbolSize-10; // Adjust for spacing between symbols

    switch (count) {
        case 2:
            positions.push({ x: centerX, y: centerY - symbolSize / 2 },
                           { x: centerX, y: centerY + symbolSize / 2 });
        break;
        case 3:
            positions.push({ x: centerX,   y:  centerY + symbolSize / 2 },
                            { x: centerX - symbolSize / 2 ,   y: centerY - symbolSize / 2 },
                            { x: centerX + symbolSize / 2, y: centerY - symbolSize / 2}); break;
        case 4:
            positions.push({ x: centerX / 2,   y: centerY /2 },
                        { x: centerX * 3 / 2, y: centerY / 2},
                        { x: centerX / 2,   y: centerY * 3 / 2 },
                        { x: centerX * 3 / 2, y: centerY * 3 / 2 }); break;
        case 5:
            positions.push({ x: centerX, y: centerY },
                        { x: centerX / 2, y: centerY / 2 },
                        { x: centerX * 3 / 2, y: centerY / 2 },
                        { x: centerX / 2, y: centerY * 3 / 2 },
                        { x: centerX * 3 / 2, y: centerY * 3 / 2 }); break;
        case 6:
            positions.push(
                { x: centerX - spacing, y: centerY - symbolSize / 2 },
                { x: centerX + spacing, y: centerY - symbolSize / 2 },
                { x: centerX - spacing, y: centerY + symbolSize / 2 },
                { x: centerX + spacing, y: centerY + symbolSize / 2 },
                { x: centerX, y: centerY - spacing },
                { x: centerX, y: centerY + spacing }); break;
        case 7:
            positions.push(
                { x: centerX, y: centerY },
                { x: centerX - spacing, y: centerY - symbolSize / 2 },
                { x: centerX + spacing, y: centerY - symbolSize / 2 },
                { x: centerX - spacing, y: centerY + symbolSize / 2 },
                { x: centerX + spacing, y: centerY + symbolSize / 2 },
                { x: centerX, y: centerY - spacing },
                { x: centerX, y: centerY + spacing }
            );break;
        case 8:
            positions.push(
                ...getSymbolPositions(4, width, height, symbolSize, margin),
                { x: centerX,   y: centerY /2 },
                { x: centerX * 3 / 2, y: centerY},
                { x: centerX,   y: centerY * 3 / 2 },
                { x: centerX /2, y: centerY}
            );break;
        case 9:
            positions.push(
                ...getSymbolPositions(8, width, height, symbolSize, margin),
                { x: centerX,   y: centerY},
            );break;
        case 10:
            positions.push(
                { x: centerX / 2,   y: centerY /2 },
                { x: centerX * 3 / 2, y: centerY / 2},
                { x: centerX / 2,   y: centerY /2 +spacing *0.8},
                { x: centerX * 3 / 2, y: centerY / 2 +spacing  *0.8 },
                { x: centerX / 2,   y: centerY /2 + spacing *2  *0.8},
                { x: centerX * 3 / 2, y: centerY / 2 + spacing *2  *0.8},
                { x: centerX / 2,   y: centerY /2 + spacing *3 *0.8},
                { x: centerX * 3 / 2, y: centerY / 2+ spacing *3 *0.8},
                { x: centerX,   y: centerY + spacing},
                { x: centerX, y: centerY - spacing},
            );break;
        
    }

    return positions;
}

// Back of Card Drawing Function
function drawCardBack(x, y) {
    ctx.translate(x, y);

    // Black border
    ctx.fillStyle = "black";
    ctx.beginPath();
    ctx.roundRect(0, 0, cardWidth, cardHeight, cornerRadius);
    ctx.fillStyle = "white";
    ctx.fill();
    ctx.strokeStyle = "black";
    ctx.stroke();

    // White border
    ctx.fillStyle = "white";
    ctx.fillRect(1, 1, cardWidth - 2, cardHeight - 2);

    // Royal blue fill
    ctx.fillStyle = "royalblue";
    ctx.fillRect(11, 11, cardWidth - 22, cardHeight - 22);

    ctx.translate(-x, -y); // Reset origin
}

// Calculate How Many Cards Fit (approximate)
const cardsPerRow = Math.ceil(canvas.width / cardWidth);
const cardsPerColumn = Math.ceil(canvas.height / cardHeight);

// Potential Color Array
const suitColors = {
    "heart":   "red",
    "spade":   "black",
    "club":    "black",
    "diamond": "red",
    "moon":    "darkgreen",
    "star":    "gold",
    "snowflake": "lightblue",
    "clover":  "darkgreen",
    "cross":   "gold",
    "skull":   "black",
    "flower":  "pink"
};


// Initial Card Values
let cardValues = {
    "spade": 0,
    "heart": 1,
    "club": 2,
    "diamond": 3
};

