#!/usr/bin/env python3
import json

with open('data/goodreadsData.json', 'r') as f:
    data = json.load(f)

# (title_fragment, author_fragment, similar_titles_list)
# Only books WITHOUT existing similarToTitles will be updated.
# Similar titles include other 5-star reads AND to-read books (for Part 3 reverse index).
patches = [
    # A.J. Baime
    ("The Arsenal of Democracy", "Baime", ["Ghost Soldiers", "Freedom's Forge", "Unbroken", "Madhouse at the End of the Earth", "The Wager"]),
    ("The Accidental President", "Baime", ["Ghost Soldiers", "A Promised Land", "Freedom's Forge", "Unbroken", "Pearl Harbor"]),

    # A.J. Finn
    ("The Woman in the Window", "Finn", ["The Silent Patient", "Behind Closed Doors", "The Breakdown", "Verity", "Into the Water"]),

    # Aaron Franklin
    ("Franklin Barbecue", "Franklin", ["Yes, Chef", "Momofuku: A Cookbook", "Notes from a Young Black Chef", "Blood, Bones, and Butter", "Why I Cook"]),

    # Adam Kay
    ("This is Going to Hurt", "Kay", ["When Breath Becomes Air", "Maybe You Should Talk to Someone", "Twas the Nightshift Before Christmas", "The Council of Dads"]),
    ("Twas the Nightshift Before Christmas", "Kay", ["This is Going to Hurt", "When Breath Becomes Air", "The Council of Dads"]),

    # Adrian McKinty
    ("The Chain", "McKinty", ["The Cold Cold Ground", "The Silent Patient", "Behind Closed Doors", "All Her Fault", "A Violent Masterpiece"]),

    # Alan Shipnuck
    ("Phil:", "Shipnuck", ["Tiger Woods", "Open", "Shoe Dog", "Three-Ring Circus", "The Last Folk Hero"]),

    # Alex Michaelides
    ("The Silent Patient", "Michaelides", ["The Fury", "The Maidens", "Behind Closed Doors", "Verity", "The Woman in the Window"]),

    # Alice Feeney
    ("Beautiful Ugly", "Feeney", ["Rock Paper Scissors", "The Silent Patient", "Behind Closed Doors", "No One Saw a Thing", "All Her Fault"]),

    # Andrea Mara
    ("All Her Fault", "Mara", ["No One Saw a Thing", "Behind Closed Doors", "The Breakdown", "The Silent Patient", "The Couple Next Door"]),

    # Andy Weir
    ("The Martian", "Weir", ["Project Hail Mary", "Artemis", "Recursion", "Dark Matter", "We Are Legion (We Are Bob)"]),
    ("Artemis", "Weir", ["The Martian", "Project Hail Mary", "Recursion", "Dark Matter", "Seveneves"]),
    ("Project Hail Mary", "Weir", ["The Martian", "Artemis", "Recursion", "Dark Matter", "Children of Time"]),
    ("The Egg", "Weir", ["Randomize", "Summer Frost", "The Martian", "Project Hail Mary"]),
    ("Randomize", "Weir", ["The Egg", "The Martian", "Dark Matter", "Recursion"]),

    # Arthur Herman
    ("Freedom's Forge", "Herman", ["The Arsenal of Democracy", "Ghost Soldiers", "Unbroken", "The Accidental President", "Pearl Harbor"]),

    # Ashlee Vance
    ("Elon Musk: Tesla", "Vance", ["Steve Jobs", "The Everything Store", "Amazon Unbound", "Super Pumped", "Power Play: Tesla, Elon Musk, and the Bet of the Century"]),
    ("When the Heavens Went on Sale", "Vance", ["Elon Musk: Tesla", "The Space Barons", "Hatching Twitter", "Super Pumped", "Steve Jobs"]),

    # Ashley Elston
    ("First Lie Wins", "Elston", ["Anatomy of an Alibi", "The Housemaid", "Behind Closed Doors", "Verity", "The Perfect Marriage"]),

    # B.A. Paris
    ("Behind Closed Doors", "B.A. Paris", ["The Breakdown", "The Prisoner", "Bring Me Back", "The Dilemma", "The Therapist"]),
    ("The Breakdown", "Paris", ["Behind Closed Doors", "The Prisoner", "The Silent Patient", "Bring Me Back", "The Therapist"]),
    ("The Prisoner", "Paris", ["Behind Closed Doors", "The Breakdown", "Verity", "The Dilemma", "The Therapist"]),

    # Barack Obama
    ("A Promised Land", "Obama", ["The Presidents Club", "Kissinger", "The Chief", "The Accidental President", "Ten Letters"]),

    # Beck Dorey-Stein
    ("From the Corner of the Oval", "Dorey-Stein", ["A Promised Land", "The Glass Castle", "Educated", "Maid"]),

    # Ben Cohen
    ("The Hot Hand", "Cohen", ["The Extra 2%", "Trading Bases", "The Only Rule Is It Has to Work", "The Midrange Theory", "Everybody Lies"]),

    # Ben Lindbergh
    ("The Only Rule Is It Has to Work", "Lindbergh", ["The Hot Hand", "The Extra 2%", "Trading Bases", "The Book of Joe", "Big Fan"]),

    # Ben Mezrich
    ("The Accidental Billionaires", "Mezrich", ["Bitcoin Billionaires", "The Dumb Money", "Hatching Twitter", "Super Pumped", "Checkmate"]),
    ("Bitcoin Billionaires", "Mezrich", ["The Accidental Billionaires", "The Dumb Money", "Flash Crash", "Digital Gold", "Checkmate"]),
    ("The Dumb Money", "Mezrich", ["Flash Boys", "Flash Crash", "Bitcoin Billionaires", "The Accidental Billionaires", "The Trolls of Wall Street"]),

    # Benjamin Lorr
    ("The Secret Life of Groceries", "Lorr", ["Blood, Bones, and Butter", "Yes, Chef", "Bourdain: The Definitive Oral Biography", "Franklin Barbecue"]),

    # Beth Macy
    ("Dopesick", "Macy", ["Evicted", "The Glass Castle", "Educated", "Paper Girl", "Amity and Prosperity"]),

    # Bill Gates
    ("Source Code", "Gates", ["Steve Jobs", "Elon Musk: Tesla", "The Everything Store", "The Innovators", "How to Prevent the Next Pandemic"]),

    # Bill Clinton
    ("The President's Daughter", "Clinton", ["The President Is Missing", "The First Gentleman", "The Plot", "The Silent Patient"]),
    ("The President Is Missing", "Clinton", ["The President's Daughter", "The First Gentleman", "The Plot", "The Chain"]),

    # Biz Stone
    ("Things a Little Bird Told Me", "Stone", ["Hatching Twitter", "The Everything Store", "Super Pumped", "Burn Book", "Traffic"]),

    # Blake Crouch
    ("Recursion", "Crouch", ["Dark Matter", "Upgrade", "Project Hail Mary", "The Martian", "Constance"]),
    ("Dark Matter", "Crouch", ["Recursion", "Upgrade", "Project Hail Mary", "The Martian", "Cassandra in Reverse"]),
    ("Upgrade", "Crouch", ["Recursion", "Dark Matter", "Project Hail Mary", "Children of Time"]),
    ("The Last Town", "Crouch", ["Pines: Wayward Pines", "Wayward: Wayward Pines", "Recursion", "Dark Matter", "The Institute"]),
    ("Wayward: Wayward Pines", "Crouch", ["Pines: Wayward Pines", "The Last Town", "Recursion", "Dark Matter"]),
    ("Pines: Wayward Pines", "Crouch", ["Wayward: Wayward Pines", "The Last Town", "Recursion", "Dark Matter", "The Outsider"]),
    ("Run", "Crouch", ["Pines: Wayward Pines", "Recursion", "Dark Matter", "The Long Walk"]),

    # Bonnie Garmus
    ("Lessons in Chemistry", "Garmus", ["Peck & Peck", "Tomorrow, and Tomorrow, and Tomorrow", "Remarkably Bright Creatures", "The Wishing Game", "Tom Lake"]),

    # Brad Parks
    ("Interference", "Parks", ["Say Nothing", "The Flight Attendant", "The Chain", "No One Will Miss Her"]),

    # Brad Stone
    ("The Everything Store", "Stone", ["Amazon Unbound", "Super Pumped", "Hatching Twitter", "The Everything War", "Elon Musk: Tesla"]),
    ("Amazon Unbound", "Stone", ["The Everything Store", "Super Pumped", "Hatching Twitter", "The Everything War", "Elon Musk: Tesla"]),

    # Brendan Borrell
    ("The First Shots", "Borrell", ["Dopesick", "The Premonition", "When Breath Becomes Air", "The End of October"]),

    # Brian O'Sullivan
    ("Clusterf", "O'Sullivan", ["Sex, Drugs, and Cocoa Puffs", "I Wear the Black Hat", "Yearbook", "The Storyteller"]),

    # Bruce Feiler
    ("The Council of Dads", "Feiler", ["When Breath Becomes Air", "Maybe You Should Talk to Someone", "The Last Lecture", "Educated"]),

    # Bryan Cranston
    ("A Life in Parts", "Cranston", ["Me", "Born to Run", "The Storyteller", "Yearbook", "Comedy Comedy Comedy Drama"]),

    # Chris Herring
    ("Blood in the Garden", "Herring", ["Dream Team", "Three-Ring Circus", "Giannis", "Return of the King", "Loose Balls"]),

    # Chris Bohjalian
    ("The Flight Attendant", "Bohjalian", ["The Jackal's Mistress", "The Silent Patient", "Behind Closed Doors", "Verity", "The Chain"]),

    # Chuck Klosterman
    ("Sex, Drugs, and Cocoa Puffs", "Klosterman", ["I Wear the Black Hat", "Killing Yourself to Live", "Downtown Owl", "Football", "Fargo Rock City"]),
    ("I Wear the Black Hat", "Klosterman", ["Sex, Drugs, and Cocoa Puffs", "Killing Yourself to Live", "The Visible Man", "Chuck Klosterman IV"]),
    ("Killing Yourself to Live", "Klosterman", ["Sex, Drugs, and Cocoa Puffs", "I Wear the Black Hat", "Downtown Owl", "Fargo Rock City"]),
    ("Raised in Captivity", "Klosterman", ["Sex, Drugs, and Cocoa Puffs", "I Wear the Black Hat", "The Visible Man", "Chuck Klosterman IV"]),

    # Colleen Hoover
    ("Verity", "Hoover", ["The Silent Patient", "Behind Closed Doors", "The Breakdown", "The Woman in the Window", "Into the Water"]),

    # Cook's Country
    ("Cook It in Cast Iron", "Cook's Country", ["Franklin Barbecue", "Momofuku: A Cookbook", "Yes, Chef", "Think Like a Chef"]),

    # Curtis Sittenfeld
    ("Romantic Comedy", "Sittenfeld", ["Lessons in Chemistry", "One Day", "Normal People", "The Wedding People", "Good Material"]),

    # Dave Grohl
    ("The Storyteller", "Grohl", ["Me", "Born to Run", "A Life in Parts", "Daisy Jones & The Six", "Yearbook"]),

    # David Chang
    ("Eat a Peach", "Chang", ["Momofuku: A Cookbook", "Yes, Chef", "Bourdain: The Definitive Oral Biography", "Blood, Bones, and Butter", "Why I Cook"]),
    ("Momofuku: A Cookbook", "Chang", ["Eat a Peach", "Yes, Chef", "Franklin Barbecue", "Blood, Bones, and Butter", "Taste"]),

    # David Grann
    ("The Wager", "Grann", ["The Lost City of Z", "Ghost Soldiers", "Unbroken", "Madhouse at the End of the Earth", "Neptune's Fortune"]),
    ("The Lost City of Z", "Grann", ["The Wager", "Into Thin Air", "Ghost Soldiers", "Madhouse at the End of the Earth", "In the Kingdom of Ice"]),

    # David Levithan
    ("Every Day", "Levithan", ["Another Day", "The Perks of Being a Wallflower", "Looking for Alaska", "Paper Towns", "Hello, Goodbye, and Everything in Between"]),
    ("Another Day", "Levithan", ["Every Day", "The Perks of Being a Wallflower", "Turtles All the Way Down", "Hello, Goodbye, and Everything in Between"]),

    # David Nicholls
    ("One Day", "Nicholls", ["Normal People", "Romantic Comedy", "Lessons in Chemistry", "Good Material", "Tom Lake"]),

    # Delia Owens
    ("Where the Crawdads Sing", "Owens", ["The Great Alone", "Lessons in Chemistry", "Remarkably Bright Creatures", "Tom Lake", "The God of the Woods"]),

    # Douglas Preston
    ("City of Endless Night", "Preston", ["Diablo Mesa", "The Plot", "The Silent Patient", "The Woman in the Window"]),

    # Drew Magary
    ("The Postmortal", "Magary", ["World War Z", "The Long Walk", "Station Eleven", "Dark Matter", "Tiger Chair"]),
    ("Someone Could Get Hurt", "Magary", ["The Glass Castle", "Educated", "The Council of Dads", "Maid"]),

    # Earl Swift
    ("Chesapeake Requiem", "Swift", ["Evicted", "Paradise", "One Day: The Extraordinary Story", "The Lost City of the Monkey God"]),

    # Elton John
    ("Me", "Elton John", ["Born to Run", "The Storyteller", "A Life in Parts", "Daisy Jones & The Six", "Yearbook"]),

    # Emiko Jean
    ("The Return of Ellie Black", "Jean", ["The Anniversary", "The Silent Patient", "The Breakdown", "All Her Fault", "Behind Closed Doors"]),

    # Emma Straub
    ("This Time Tomorrow", "Straub", ["American Fantasy", "The Midnight Library", "How to Stop Time", "Cassandra in Reverse", "Tomorrow, and Tomorrow, and Tomorrow"]),

    # Freida McFadden
    ("The Housemaid is Watching", "McFadden", ["The Housemaid", "The Housemaid's Secret", "The Boyfriend", "The Divorce", "The Crash"]),
    ("Ward D", "McFadden", ["The Housemaid", "The Teacher", "Never Lie", "The Inmate", "The Tenant"]),
    ("The Housemaid's Wedding", "McFadden", ["The Housemaid", "The Housemaid's Secret", "The Boyfriend", "The Crash", "Never Lie"]),
    ("The Housemaid (The Housemaid, #1)", "McFadden", ["The Housemaid's Secret", "Never Lie", "The Teacher", "The Boyfriend", "The Divorce"]),
    ("The Teacher", "McFadden", ["The Housemaid", "Never Lie", "Ward D", "The Inmate", "The Crash"]),
    ("Never Lie", "McFadden", ["The Housemaid", "The Teacher", "Ward D", "The Boyfriend", "The Tenant"]),
    ("The Housemaid's Secret", "McFadden", ["The Housemaid", "Ward D", "The Teacher", "The Divorce", "The Crash"]),

    # Gabrielle Zevin
    ("Tomorrow, and Tomorrow, and Tomorrow", "Zevin", ["The Storied Life of A.J. Fikry", "Lessons in Chemistry", "The Midnight Library", "Remarkably Bright Creatures", "Tom Lake"]),
    ("The Storied Life of A.J. Fikry", "Zevin", ["Tomorrow, and Tomorrow, and Tomorrow", "Remarkably Bright Creatures", "The Wishing Game", "Lessons in Chemistry", "The Midnight Library"]),

    # Gail Simmons
    ("Talking with My Mouth Full", "Simmons", ["Eat a Peach", "Yes, Chef", "Bourdain: The Definitive Oral Biography", "Save Me the Plums", "Taste"]),

    # Gary Shteyngart
    ("Lake Success", "Shteyngart", ["White Noise", "Normal People", "Beautiful World, Where Are You", "The Amazing Adventures of Cavalier & Clay"]),

    # Gene Weingarten
    ("One Day: The Extraordinary Story", "Weingarten", ["The Fiddler in the Subway", "Chesapeake Requiem", "The Day the World Came to Town", "Evicted"]),

    # Gillian Flynn
    ("Dark Places", "Flynn", ["Sharp Objects", "The Woman in the Window", "The Silent Patient", "I'll Be Gone in the Dark", "Verity"]),
    ("Sharp Objects", "Flynn", ["Dark Places", "The Woman in the Window", "The Silent Patient", "I'll Be Gone in the Dark", "Verity"]),

    # Graeme Simsion
    ("The Rosie Project", "Simsion", ["The Rosie Effect", "The Rosie Result", "Romantic Comedy", "Lessons in Chemistry", "My Friends"]),
    ("The Rosie Result", "Simsion", ["The Rosie Project", "The Rosie Effect", "Romantic Comedy", "Lessons in Chemistry", "Here One Moment"]),
    ("The Rosie Effect", "Simsion", ["The Rosie Project", "The Rosie Result", "Romantic Comedy", "Lessons in Chemistry"]),

    # Gregory Zuckerman
    ("The Man Who Solved the Market", "Zuckerman", ["Flash Boys", "The Big Short", "Flash Crash", "Going Infinite", "Den of Thieves"]),

    # Hampton Sides
    ("Ghost Soldiers", "Sides", ["Blood and Thunder", "In the Kingdom of Ice", "The Wide Wide Sea", "Unbroken", "The Arsenal of Democracy"]),

    # Harlan Coben
    ("The Woods", "Coben", ["The Chain", "The Silent Patient", "Behind Closed Doors", "All Her Fault", "Say Nothing"]),

    # Jack McCallum
    ("Dream Team", "McCallum", ["Three-Ring Circus", "Blood in the Garden", "Return of the King", "Wilt", "Loose Balls"]),

    # James Patterson
    ("Along Came a Spider", "Patterson", ["Kiss the Girls", "12 Months to Live", "The Girl in the Castle", "Juror #3", "The Perfect Assassin"]),
    ("The Perfect Assassin", "Patterson", ["Along Came a Spider", "Kiss the Girls", "12 Months to Live", "The Idaho Four"]),
    ("The Jailhouse Lawyer", "Patterson", ["Along Came a Spider", "Kiss the Girls", "Juror #3", "12 Months to Live"]),
    ("Kiss the Girls", "Patterson", ["Along Came a Spider", "The Jailhouse Lawyer", "12 Months to Live", "The Girl in the Castle", "The Idaho Four"]),

    # James Crumley
    ("The Last Good Kiss", "Crumley", ["She Rides Shotgun", "Everybody Knows", "Blacktop Wasteland", "Clean Hands", "Hard Cash Valley"]),

    # James Murray
    ("The Stowaway", "Murray", ["Ghost Soldiers", "The Wager", "Madhouse at the End of the Earth", "Into Thin Air"]),

    # Jared Dudley
    ("Inside the NBA Bubble", "Dudley", ["Dream Team", "Blood in the Garden", "Three-Ring Circus", "Return of the King", "Giannis"]),

    # Jean Hanff Korelitz
    ("The Plot", "Korelitz", ["The Latecomer", "The Silent Patient", "None of This Is True", "Tomorrow, and Tomorrow, and Tomorrow", "The Woman in the Window"]),

    # Jeanine Cummins
    ("American Dirt", "Cummins", ["Where the Crawdads Sing", "The Great Alone", "The Glass Castle", "Exit West", "Tom Lake"]),

    # Jeannette Walls
    ("The Glass Castle", "Walls", ["Educated", "Maid", "The Liars' Club", "When Breath Becomes Air", "A Hope in the Unseen"]),

    # Jeff Benedict
    ("Tiger Woods", "Benedict", ["Open", "Three-Ring Circus", "The Last Folk Hero", "Sweetness", "Baddest Man"]),

    # Jeff Gordinier
    ("Hungry:", "Gordinier", ["Eat a Peach", "Bourdain: The Definitive Oral Biography", "Yes, Chef", "Blood, Bones, and Butter", "Taste"]),

    # Jeff Pearlman
    ("Three-Ring Circus", "Pearlman", ["Dream Team", "Blood in the Garden", "Boys Will Be Boys", "Football for a Buck", "Sweetness"]),
    ("The Last Folk Hero", "Pearlman", ["Three-Ring Circus", "Tiger Woods", "Dream Team", "Sweetness", "The Rocket That Fell to Earth"]),

    # Jeneva Rose
    ("The Perfect Divorce", "Rose", ["The Perfect Marriage", "Home Is Where the Bodies Are", "Dating After the End of the World", "Behind Closed Doors", "Verity"]),
    ("Home Is Where the Bodies Are", "Rose", ["The Perfect Marriage", "The Perfect Divorce", "Dating After the End of the World", "The Housemaid"]),
    ("The Perfect Marriage", "Rose", ["The Perfect Divorce", "Home Is Where the Bodies Are", "Dating After the End of the World", "Behind Closed Doors", "The Housemaid"]),

    # Jennifer E. Smith
    ("The Statistical Probability of Love at First Sight", "Smith", ["Hello, Goodbye, and Everything in Between", "Every Day", "Looking for Alaska", "The Perks of Being a Wallflower"]),

    # Jennifer Hillier
    ("Freak (Creep", "Hillier", ["Creep (Creep", "Little Secrets", "The Housemaid", "Behind Closed Doors", "The Silent Patient"]),
    ("Creep (Creep", "Hillier", ["Freak (Creep", "Little Secrets", "The Housemaid", "The Silent Patient", "Never Lie"]),
    ("Little Secrets", "Hillier", ["Creep (Creep", "Freak (Creep", "The Housemaid", "Behind Closed Doors", "None of This Is True"]),

    # Jessica Pan
    ("Sorry I'm Late", "Pan", ["Bossypants", "Not That Kind of Girl", "Yearbook", "Scrappy Little Nobody"]),

    # Jim DeFede
    ("The Day the World Came to Town", "DeFede", ["One Day: The Extraordinary Story", "Chesapeake Requiem", "A Hope in the Unseen", "The Council of Dads"]),

    # Joan Biskupic
    ("The Chief:", "Biskupic", ["A Promised Land", "The Nine", "While Justice Sleeps", "The Presidents Club", "The Genome Defense"]),

    # Joe Peta
    ("Trading Bases", "Peta", ["The Extra 2%", "The Hot Hand", "The Only Rule Is It Has to Work", "Everybody Lies", "The Midrange Theory"]),

    # Joe Pisapia
    ("The Fantasy Baseball Black Book", "Pisapia", ["Trading Bases", "The Extra 2%", "The Only Rule Is It Has to Work", "The Book of Joe"]),

    # John Green
    ("Paper Towns", "Green", ["Looking for Alaska", "Turtles All the Way Down", "The Perks of Being a Wallflower", "Every Day"]),
    ("Looking for Alaska", "Green", ["Paper Towns", "Turtles All the Way Down", "The Perks of Being a Wallflower", "Every Day"]),
    ("Turtles All the Way Down", "Green", ["Looking for Alaska", "Paper Towns", "The Perks of Being a Wallflower", "Every Day"]),

    # John Donohue
    ("The Greatest Beer Run Ever", "Donohue", ["Ghost Soldiers", "The Arsenal of Democracy", "Into Thin Air", "A Hope in the Unseen"]),

    # John D. MacDonald
    ("Cape Fear", "MacDonald", ["She Rides Shotgun", "Everybody Knows", "Blacktop Wasteland", "Clean Hands", "Hard Cash Valley"]),

    # John Grisham 5-star books
    ("The Widow", "Grisham", ["A Time to Kill", "The Client", "The Firm", "Partners: A Rogue Lawyer Short Story", "The French Illusion"]),
    ("A Time to Kill", "Grisham", ["Sycamore Row", "A Time for Mercy", "The Client", "The Firm", "Partners: A Rogue Lawyer Short Story"]),
    ("The Street Lawyer", "Grisham", ["The Client", "The Rainmaker", "The Litigators", "A Time to Kill", "The French Illusion"]),
    ("The Client", "Grisham", ["A Time to Kill", "The Firm", "The Rainmaker", "Sycamore Row", "Partners: A Rogue Lawyer Short Story"]),
    ("The Exchange", "Grisham", ["The Firm", "The Partner", "The Broker", "The Boys from Biloxi", "The French Illusion"]),
    ("The Firm (The Firm, #1)", "Grisham", ["A Time to Kill", "The Client", "The Rainmaker", "The Runaway Jury", "Partners: A Rogue Lawyer Short Story"]),
    ("Camino Ghosts", "Grisham", ["Camino Island", "Camino Winds", "The Boys from Biloxi", "The Exchange", "The French Illusion"]),
    ("The Boys from Biloxi", "Grisham", ["A Time to Kill", "The Reckoning", "Sycamore Row", "A Time for Mercy", "The French Illusion"]),
    ("The Judge's List", "Grisham", ["The Whistler", "The Litigators", "The Runaway Jury", "The Last Juror", "Partners: A Rogue Lawyer Short Story"]),
    ("Sooley", "Grisham", ["The Boys from Biloxi", "Calico Joe", "Bleachers", "The Reckoning"]),
    ("A Time for Mercy", "Grisham", ["A Time to Kill", "Sycamore Row", "The Boys from Biloxi", "The Client", "Partners: A Rogue Lawyer Short Story"]),
    ("Camino Winds", "Grisham", ["Camino Island", "Camino Ghosts", "The Boys from Biloxi", "The Exchange", "The French Illusion"]),
    ("The Reckoning", "Grisham", ["A Time to Kill", "The Boys from Biloxi", "Sycamore Row", "A Time for Mercy"]),
    ("Sycamore Row", "Grisham", ["A Time to Kill", "A Time for Mercy", "The Boys from Biloxi", "The Client", "Partners: A Rogue Lawyer Short Story"]),
    ("The King of Torts", "Grisham", ["The Rainmaker", "The Litigators", "The Last Juror", "The Runaway Jury", "The French Illusion"]),
    ("The Last Juror", "Grisham", ["The King of Torts", "The Rainmaker", "A Time to Kill", "The Litigators", "Partners: A Rogue Lawyer Short Story"]),
    ("The Partner", "Grisham", ["The Firm", "The Exchange", "The Broker", "The Rainmaker", "The French Illusion"]),
    ("The Rainmaker", "Grisham", ["The Client", "The Litigators", "The Street Lawyer", "The Last Juror", "Partners: A Rogue Lawyer Short Story"]),
    ("The Runaway Jury", "Grisham", ["The Firm", "The Rainmaker", "The Last Juror", "The Judge's List", "The French Illusion"]),
    ("The Litigators", "Grisham", ["The Rainmaker", "The King of Torts", "The Judge's List", "The Runaway Jury", "Partners: A Rogue Lawyer Short Story"]),

    # John Sandford
    ("The Investigator", "Sandford", ["Dark Angel", "Along Came a Spider", "The Chain", "Hard to Break"]),

    # Jon Krakauer
    ("Into Thin Air", "Krakauer", ["The Wager", "Ghost Soldiers", "Madhouse at the End of the Earth", "Under the Banner of Heaven", "Where Men Win Glory"]),

    # Jonathan Grotenstein
    ("Ship It Holla Ballas", "Grotenstein", ["Molly's Game", "Flash Boys", "Trading Bases", "Gambler", "You Can't Lose Them All"]),

    # Jordan Harper
    ("She Rides Shotgun", "Harper", ["Everybody Knows", "A Violent Masterpiece", "Blacktop Wasteland", "Hard Cash Valley", "Razorblade Tears"]),
    ("Everybody Knows", "Harper", ["She Rides Shotgun", "A Violent Masterpiece", "Blacktop Wasteland", "The Last Good Kiss", "Hard Cash Valley"]),

    # Joshua Robinson
    ("The Formula:", "Robinson", ["Three-Ring Circus", "Dream Team", "Open", "Shoe Dog", "Tiger Woods"]),

    # Julian Sancton
    ("Madhouse at the End of the Earth", "Sancton", ["Neptune's Fortune", "The Wager", "Into Thin Air", "Ghost Soldiers", "In the Kingdom of Ice"]),

    # Kat Rosenfield
    ("No One Will Miss Her", "Rosenfield", ["You Must Remember This", "The Silent Patient", "Behind Closed Doors", "Verity", "The Housemaid"]),

    # Keith O'Brien
    ("Charlie Hustle", "O'Brien", ["Heartland", "Tiger Woods", "The Last Folk Hero", "Three-Ring Circus", "Dream Team"]),

    # Ken Grossman
    ("Beyond the Pale", "Grossman", ["The Lagunitas Story", "Shoe Dog", "Eat a Peach", "Bitter Brew", "Franklin Barbecue"]),

    # Kristin Hannah
    ("The Great Alone", "Hannah", ["Where the Crawdads Sing", "Lessons in Chemistry", "The Invisible Life of Addie LaRue", "Tom Lake", "The God of the Woods"]),

    # Kwame Onwuachi
    ("Notes from a Young Black Chef", "Onwuachi", ["Yes, Chef", "Eat a Peach", "Bourdain: The Definitive Oral Biography", "Crying in H Mart", "L.A. Son"]),

    # Laura Dave
    ("The Last Thing He Told Me", "Dave", ["The Silent Patient", "The Housemaid", "Behind Closed Doors", "Local Woman Missing", "Listen for the Lie"]),

    # Laura Hillenbrand
    ("Unbroken", "Hillenbrand", ["Ghost Soldiers", "The Arsenal of Democracy", "Freedom's Forge", "The Wager", "Where Men Win Glory"]),

    # Laurie Woolever
    ("Bourdain: The Definitive Oral Biography", "Woolever", ["Care and Feeding", "Eat a Peach", "Yes, Chef", "Hungry:", "Blood, Bones, and Butter"]),

    # Lawrence Wright
    ("The End of October", "Wright", ["The Premonition", "Mr. Texas", "Dopesick", "The Flight Attendant"]),

    # Lena Dunham
    ("Not That Kind of Girl", "Dunham", ["Famesick", "Sorry I'm Late", "Yearbook", "The Woman in Me", "Bossypants"]),

    # Liam Vaughan
    ("Flash Crash", "Vaughan", ["Flash Boys", "The Big Short", "The Man Who Solved the Market", "Going Infinite", "Den of Thieves"]),

    # Lisa Jewell
    ("None of This Is True", "Jewell", ["The Silent Patient", "Behind Closed Doors", "The Breakdown", "Verity", "No One Saw a Thing"]),

    # Lisa Taddeo
    ("Three Women", "Taddeo", ["Ghost Lover", "Educated", "The Glass Castle", "Maid", "Crying in H Mart"]),

    # Lizzie Johnson
    ("Paradise:", "Johnson", ["Fire Weather", "Evicted", "Dopesick", "Chesapeake Requiem", "Amity and Prosperity"]),

    # Lori Gottlieb
    ("Maybe You Should Talk to Someone", "Gottlieb", ["When Breath Becomes Air", "Hidden Valley Road", "The Glass Castle", "Bittersweet", "Good Morning, Monster"]),

    # Lucy Foley
    ("The Guest List", "Foley", ["The Paris Apartment", "The Silent Patient", "Behind Closed Doors", "Verity", "All Her Fault"]),

    # Malcolm Gladwell
    ("The Bomber Mafia", "Gladwell", ["Ghost Soldiers", "The Arsenal of Democracy", "Unbroken", "Freedom's Forge", "Pearl Harbor"]),

    # Marc Randolph
    ("That Will Never Work", "Randolph", ["Shoe Dog", "The Everything Store", "Super Pumped", "Hatching Twitter", "Steve Jobs"]),

    # Marcus Samuelsson
    ("Yes, Chef", "Samuelsson", ["Eat a Peach", "Bourdain: The Definitive Oral Biography", "Notes from a Young Black Chef", "Blood, Bones, and Butter", "Taste"]),

    # Marisa Kashino
    ("Best Offer Wins", "Kashino", ["Evicted", "The Secret Life of Groceries", "Shoe Dog", "The Everything Store"]),

    # Martin MacInnes
    ("In Ascension", "MacInnes", ["The Martian", "Seveneves", "Project Hail Mary", "The Mountain in the Sea", "Children of Time"]),

    # Matt Haig
    ("The Midnight Library", "Haig", ["The Midnight Train", "The Humans", "This Time Tomorrow", "The Invisible Life of Addie LaRue", "The Measure"]),

    # Matthew Desmond
    ("Evicted", "Desmond", ["Maid", "Dopesick", "The Glass Castle", "Paradise", "Amity and Prosperity"]),

    # Max Brooks
    ("World War Z", "Max Brooks", ["Tiger Chair", "The Postmortal", "The Stand", "Station Eleven", "The Long Walk"]),

    # Meg Shaffer
    ("The Wishing Game", "Shaffer", ["The Storied Life of A.J. Fikry", "The Midnight Library", "Remarkably Bright Creatures", "Lessons in Chemistry", "Tomorrow, and Tomorrow, and Tomorrow"]),

    # Michael Lewis
    ("Flash Boys", "Michael   Lewis", ["The Big Short", "Going Infinite", "The Man Who Solved the Market", "Flash Crash", "Den of Thieves"]),
    ("The Blind Side", "Michael   Lewis", ["A Hope in the Unseen", "Unbroken", "Three-Ring Circus", "Dream Team", "Shoe Dog"]),
    ("The Big Short", "Michael   Lewis", ["Flash Boys", "Going Infinite", "The Man Who Solved the Market", "Flash Crash", "Den of Thieves"]),
    ("Going Infinite", "Michael   Lewis", ["Flash Boys", "The Big Short", "The Man Who Solved the Market", "Bitcoin Billionaires", "The Trolls of Wall Street"]),

    # Michael Crichton
    ("Eruption", "Crichton", ["Dark Matter", "Recursion", "The Martian", "Project Hail Mary", "Upgrade"]),

    # Michael Finkel
    ("The Art Thief", "Finkel", ["Flash Crash", "American Kingpin", "Neptune's Fortune", "Chasing the Thrill"]),

    # Michael Ledwidge
    ("Run for Cover", "Ledwidge", ["Stop at Nothing", "Hard to Break", "The Chain", "Dark Angel", "Along Came a Spider"]),
    ("Stop at Nothing", "Ledwidge", ["Run for Cover", "Hard to Break", "The Chain", "Dark Angel"]),

    # Michael Ruhlman
    ("The Making of a Chef", "Ruhlman", ["If You Can't Take the Heat", "The Soul of a Chef", "Eat a Peach", "Yes, Chef", "Blood, Bones, and Butter"]),

    # Michelle Zauner
    ("Crying in H Mart", "Zauner", ["Yes, Chef", "Eat a Peach", "Notes from a Young Black Chef", "Save Me the Plums", "Blood, Bones, and Butter"]),

    # Mike Evans
    ("Hangry:", "Evans", ["Shoe Dog", "The Everything Store", "Super Pumped", "That Will Never Work"]),

    # Mike Isaac
    ("Super Pumped", "Isaac", ["Hatching Twitter", "The Everything Store", "Amazon Unbound", "Burn Book", "Empire of AI"]),

    # Mirin Fader
    ("Giannis", "Fader", ["Dream Team", "Three-Ring Circus", "Blood in the Garden", "A Hollywood Ending", "Return of the King"]),

    # Molly Bloom
    ("Molly's Game", "Bloom", ["Ship It Holla Ballas", "Flash Boys", "The Man Who Solved the Market", "Gambler", "You Can't Lose Them All"]),

    # Natalie Sue
    ("I Hope This Finds You Well", "Sue", ["Romantic Comedy", "Lessons in Chemistry", "The Rosie Project", "The Wedding People", "Good Material"]),

    # Neal Stephenson
    ("Seveneves", "Stephenson", ["Snow Crash", "Termination Shock", "The Martian", "Project Hail Mary", "Children of Time"]),

    # Nick Greene
    ("How to Watch Basketball Like a Genius", "Greene", ["The Hot Hand", "The Extra 2%", "Trading Bases", "The Midrange Theory", "Dream Team"]),

    # Nick Bilton
    ("Hatching Twitter", "Bilton", ["Super Pumped", "The Everything Store", "Things a Little Bird Told Me", "Burn Book", "Traffic"]),
    ("American Kingpin", "Bilton", ["Flash Crash", "The Art Thief", "Going Infinite", "Molly's Game", "Inside the Cartel"]),

    # Nikki Erlick
    ("The Measure", "Erlick", ["The Midnight Library", "The Invisible Life of Addie LaRue", "This Time Tomorrow", "Cassandra in Reverse", "Remarkably Bright Creatures"]),

    # Nita Prose
    ("The Mystery Guest", "Prose", ["The Maid's Secret", "The Mistletoe Mystery", "The Maid", "The Silent Patient", "The Plot"]),

    # Patrick Hoffman
    ("The White Van", "Hoffman", ["Clean Hands", "Every Man a Menace", "She Rides Shotgun", "Blacktop Wasteland", "A Violent Masterpiece"]),

    # Paul Kalanithi
    ("When Breath Becomes Air", "Kalanithi", ["Maybe You Should Talk to Someone", "The Council of Dads", "Educated", "Riding the Lightning", "The Glass Castle"]),

    # Phil Knight
    ("Shoe Dog", "Knight", ["The Everything Store", "Steve Jobs", "Amazon Unbound", "Built from Scratch", "What It Takes"]),

    # Rachel Hawkins
    ("The Heiress", "Hawkins", ["The Silent Patient", "Behind Closed Doors", "Verity", "The Housemaid", "Into the Water"]),

    # Randy Garutti
    ("Shake Shack", "Garutti", ["Eat a Peach", "The Soul of a Chef", "Franklin Barbecue", "Why I Cook", "Taste"]),

    # Randy Pausch
    ("The Last Lecture", "Pausch", ["When Breath Becomes Air", "The Council of Dads", "Maybe You Should Talk to Someone", "Educated"]),

    # Reese Witherspoon
    ("Gone Before Goodbye", "Witherspoon", ["The Silent Patient", "Behind Closed Doors", "The Housemaid", "Verity", "The Breakdown"]),

    # Rich Cohen
    ("The Chicago Cubs", "Cohen", ["Charlie Hustle", "Tiger Woods", "Three-Ring Circus", "Pee Wees", "Dream Team"]),

    # Robert Bailey
    ("The Boomerang", "Bailey", ["Rich Blood", "A Time to Kill", "The Client", "An Innocent Client"]),
    ("The Golfer's Carol", "Bailey", ["Rich Blood", "A Time to Kill", "The Client", "The Boomerang"]),

    # Robin Waterfield
    ("The Firm (Penguin Readers", "Waterfield", ["The Firm (The Firm, #1)", "A Time to Kill", "The Client", "The Rainmaker"]),

    # Ron Suskind
    ("A Hope in the Unseen", "Suskind", ["Maid", "Evicted", "The Glass Castle", "Educated", "The Blind Side"]),

    # Ruth Reichl
    ("Save Me the Plums", "Reichl", ["Eat a Peach", "Yes, Chef", "Bourdain: The Definitive Oral Biography", "Crying in H Mart", "Blood, Bones, and Butter"]),

    # S.A. Cosby
    ("Blacktop Wasteland", "Cosby", ["Razorblade Tears", "She Rides Shotgun", "Everybody Knows", "A Violent Masterpiece", "Hard Cash Valley"]),

    # S.J. Watson
    ("Before I Go to Sleep", "Watson", ["The Silent Patient", "Behind Closed Doors", "The Breakdown", "Verity", "Local Woman Missing"]),

    # Sam Walker
    ("Fantasyland", "Walker", ["Trading Bases", "The Extra 2%", "The Hot Hand", "The Only Rule Is It Has to Work", "You Can't Lose Them All"]),

    # Sarah Gailey
    ("The Echo Wife", "Gailey", ["Magic for Liars", "Recursion", "The Invisible Life of Addie LaRue", "The Measure", "The Mountain in the Sea"]),

    # Scott Alexander Howard
    ("The Other Valley", "Howard", ["The Midnight Library", "Recursion", "Dark Matter", "Cassandra in Reverse", "The Measure"]),

    # Scott Bradlee
    ("Outside the Jukebox", "Bradlee", ["The Storyteller", "Me", "Born to Run", "Daisy Jones & The Six"]),

    # Scott Turow
    ("Presumed Innocent", "Turow", ["The Last Trial", "Pleading Guilty", "A Time to Kill", "The Firm", "The Rainmaker"]),
    ("Pleading Guilty", "Turow", ["Presumed Innocent", "The Last Trial", "The Burden of Proof", "A Time to Kill"]),

    # Seth Rogen
    ("Yearbook", "Rogen", ["Comedy Comedy Comedy Drama", "Entrances and Exits", "Born to Run", "Me", "A Life in Parts"]),

    # Shari Lapena
    ("She Didn't See It Coming", "Lapena", ["The Couple Next Door", "Behind Closed Doors", "The Breakdown", "The Silent Patient", "Verity"]),

    # Shelby Van Pelt
    ("Remarkably Bright Creatures", "Van Pelt", ["The Storied Life of A.J. Fikry", "The Midnight Library", "Lessons in Chemistry", "The Wishing Game", "Tom Lake"]),

    # Sierra Greer
    ("Annie Bot", "Greer", ["The Echo Wife", "The Measure", "Recursion", "Dark Matter", "The Mountain in the Sea"]),

    # Stephanie Land
    ("Maid:", "Land", ["Class", "Evicted", "Educated", "The Glass Castle", "The Liars' Club"]),

    # Stephen King
    ("Never Flinch", "King", ["Holly", "The Outsider", "Billy Summers", "Mr. Mercedes", "Revival"]),
    ("The Outsider", "King", ["Holly", "Never Flinch", "Billy Summers", "Mr. Mercedes", "The Life of Chuck"]),
    ("The Stand", "King", ["World War Z", "The Postmortal", "Billy Summers", "Sleeping Beauties", "The Running Man"]),
    ("Elevation", "King", ["The Outsider", "Holly", "Billy Summers", "The Institute", "Mr. Mercedes"]),
    ("Holly", "King", ["The Outsider", "Never Flinch", "Billy Summers", "Mr. Mercedes", "Gwendy's Final Task"]),
    ("Billy Summers", "King", ["The Outsider", "Holly", "Never Flinch", "Mr. Mercedes", "The Life of Chuck"]),

    # Steve Cavanagh
    ("Kill for Me, Kill for You", "Cavanagh", ["Th1rt3en", "The Outsider", "The Plot", "The Silent Patient", "The Flight Attendant"]),

    # T.J. Newman
    ("Drowning", "Newman", ["Falling", "Worst Case Scenario", "The Chain", "The Flight Attendant"]),
    ("Falling", "Newman", ["Drowning", "Worst Case Scenario", "The Chain", "The Flight Attendant"]),

    # Tara Westover
    ("Educated", "Westover", ["The Glass Castle", "Maid", "The Liars' Club", "When Breath Becomes Air", "Three Women"]),

    # Taylor Jenkins Reid
    ("The Seven Husbands of Evelyn Hugo", "Reid", ["Daisy Jones & The Six", "Malibu Rising", "Carrie Soto Is Back", "Atmosphere", "Intermezzo"]),
    ("Daisy Jones & The Six", "Reid", ["The Seven Husbands of Evelyn Hugo", "Malibu Rising", "Carrie Soto Is Back", "Tom Lake", "Atmosphere"]),
    ("Carrie Soto Is Back", "Reid", ["The Seven Husbands of Evelyn Hugo", "Daisy Jones & The Six", "Malibu Rising", "Atmosphere"]),
    ("Atmosphere", "Reid", ["The Seven Husbands of Evelyn Hugo", "Daisy Jones & The Six", "Carrie Soto Is Back", "Malibu Rising"]),
    ("After I Do", "Reid", ["Maybe in Another Life", "One True Loves", "Malibu Rising", "The Seven Husbands of Evelyn Hugo"]),
    ("Maybe in Another Life", "Reid", ["After I Do", "One True Loves", "The Seven Husbands of Evelyn Hugo", "Romantic Comedy"]),
    ("One True Loves", "Reid", ["After I Do", "Maybe in Another Life", "The Seven Husbands of Evelyn Hugo", "Malibu Rising"]),
    ("Malibu Rising", "Reid", ["The Seven Husbands of Evelyn Hugo", "Daisy Jones & The Six", "Carrie Soto Is Back", "Tom Lake"]),

    # Ted Conover
    ("Newjack", "Conover", ["Cheap Land Colorado", "Maid", "Evicted", "The Glass Castle", "A Hope in the Unseen"]),

    # Todd Zolecki
    ("Doc:", "Zolecki", ["Tiger Woods", "The Last Folk Hero", "Charlie Hustle", "Dream Team", "Three-Ring Circus"]),

    # Tom Perrotta
    ("Little Children", "Perrotta", ["Tracy Flick Can't Win", "Normal People", "Lessons in Chemistry", "Bad Haircut", "Beautiful World, Where Are You"]),
    ("Tracy Flick Can't Win", "Perrotta", ["Little Children", "Normal People", "Lessons in Chemistry", "Bad Haircut"]),

    # Tom Verducci
    ("The Cubs Way", "Verducci", ["Charlie Hustle", "Tiger Woods", "Three-Ring Circus", "Dream Team"]),

    # Tony Horwitz
    ("BOOM:", "Horwitz", ["Methland", "Dopesick", "Chesapeake Requiem", "Evicted"]),

    # Tony Magee
    ("The Lagunitas Story", "Magee", ["Beyond the Pale", "Shoe Dog", "Eat a Peach", "Bitter Brew", "Franklin Barbecue"]),

    # V.E. Schwab
    ("The Invisible Life of Addie LaRue", "Schwab", ["The Midnight Library", "Tomorrow, and Tomorrow, and Tomorrow", "The Measure", "Cassandra in Reverse", "This Time Tomorrow"]),

    # Walter Isaacson
    ("The Greatest Sentence Ever Written", "Isaacson", ["Steve Jobs", "The Innovators", "American Sketches", "Kissinger", "The Wise Men"]),
    ("Steve Jobs", "Isaacson", ["Elon Musk", "The Innovators", "The Code Breaker", "Kissinger", "American Sketches"]),
    ("The Innovators", "Isaacson", ["Steve Jobs", "Elon Musk", "The Code Breaker", "The Wise Men", "Kissinger"]),
    ("Elon Musk", "Walter Isaacson", ["Steve Jobs", "The Innovators", "The Code Breaker", "Elon Musk: Tesla", "American Sketches"]),
    ("The Code Breaker", "Isaacson", ["Steve Jobs", "Elon Musk", "The Innovators", "Source Code", "American Sketches"]),

    # Wright Thompson
    ("Pappyland", "Thompson", ["Franklin Barbecue", "Beyond the Pale", "The Lagunitas Story", "The Cost of These Dreams", "Bitter Brew"]),

    # Yaron Weitzman
    ("Tanking to the Top", "Weitzman", ["A Hollywood Ending", "Return of the King", "Dream Team", "Blood in the Garden", "Giannis"]),
]

updated = 0
unmatched = []

for title_frag, author_frag, similar in patches:
    matches = [b for b in data['books']
               if title_frag.lower() in b.get('title', '').lower()
               and author_frag.lower() in b.get('author', '').lower()]
    if not matches:
        unmatched.append((title_frag, author_frag))
        continue
    for book in matches:
        if not book.get('similarToTitles') or len(book.get('similarToTitles', [])) == 0:
            book['similarToTitles'] = similar
            updated += 1

with open('data/goodreadsData.json', 'w') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)

print(f"Updated: {updated} books")
if unmatched:
    print(f"Unmatched ({len(unmatched)}):")
    for t, a in unmatched:
        print(f"  '{t}' / '{a}'")
else:
    print("All patches matched.")
