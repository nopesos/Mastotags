document.addEventListener('DOMContentLoaded', () => {
    const searchForm = document.getElementById('search-form');
    const searchTerm = document.getElementById('search-term');
    const resultsContainer = document.getElementById('results-container');
    const hashtagsList = document.getElementById('hashtags-list');
    const loadingIndicator = document.getElementById('loading');
    const errorMessage = document.getElementById('error-message');
    const createMastowallBtn = document.getElementById('create-mastowall-btn');

    // Mastodon API Endpunkte
    const MASTODON_INSTANCES = [
        'https://mastodon.social',
        'https://wisskomm.social',
        'https://openbiblio.social',
        'https://mathstodon.xyz',
        'https://higher-edu.social',
        'https://social.edu.nl',
        'https://archaeo.social',
        'https://mstdn.science',
        'https://newsie.social',
        'https://fediscience.org',
        'https://social.fz-juelich.de',
        'https://sciences.social',
        'https://meteo.social',
        'https://scicomm.xyz',
        'https://bildung.social',
        'https://genomic.social',
        'https://literatur.social',
        'https://sciencemastodon.com',
        'https://podcasts.social',
        'https://masto.ai',
        'https://astrodon.social',
        'https://reporter.social',
        'https://colearn.social',
        'https://econtwitter.net',
        'https://scholar.social',
        'https://urbanists.social',
        'https://idw-online.social',
        'https://helmholtz.social',
        'https://academiccloud.social',
        'https://hcommons.social',
        'https://akademienl.social',
        'https://mastodon.lawprofs.org',
        'https://social.mpdl.mpg.de',
        'https://legal.social',
        'https://sciencemediacenter.social',
        'https://w3c.social',
        'https://social.uibk.ac.at'

    ];

    const DEFAULT_MASTOWALL_INSTANCE = 'https://mastodon.social';

    // Settings for extended search
    const MAX_RELATED_HASHTAGS = 5;
    const MAX_DEPTH = 1; // Depth of recursive search
    const MAX_SELECTED_HASHTAGS = 3; // Maximum number of selected hashtags

    // Array for selected hashtags
    let selectedHashtags = [];

    searchForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const query = searchTerm.value.trim();
        if (!query) return;

        // Reset UI
        hashtagsList.innerHTML = '';
        errorMessage.classList.add('d-none');
        resultsContainer.classList.remove('d-none');
        loadingIndicator.classList.remove('d-none');
        selectedHashtags = []; // Reset selected hashtags
        updateMastowallButton();

        try {
            const hashtags = await findRelatedHashtagsExtended(query);
            displayHashtags(hashtags);
        } catch (error) {
            showError(error.message || 'An error occurred while retrieving hashtags.');
        } finally {
            loadingIndicator.classList.add('d-none');
        }
    });

    // Main function: Performs an extended search with parallel API calls
    async function findRelatedHashtagsExtended(query) {
        console.log(`Starting parallel search across ${MASTODON_INSTANCES.length} instances for "${query}"`);

        // Global map for toots across all instances for deduplication
        const globalTootsMap = new Map();

        // Phase 1: Initial parallel search across all instances
        console.log('Phase 1: Initial search across all instances...');
        const initialSearchPromises = MASTODON_INSTANCES.map(instance =>
            searchInstanceInitial(instance, query, globalTootsMap)
        );

        const initialResults = await Promise.allSettled(initialSearchPromises);

        // Process initial results
        let anyResultsFound = false;
        initialResults.forEach((result, index) => {
            if (result.status === 'fulfilled' && result.value > 0) {
                anyResultsFound = true;
                console.log(`Instance ${MASTODON_INSTANCES[index]} contributed ${result.value} toots`);
            } else if (result.status === 'rejected') {
                console.warn(`Initial search failed for ${MASTODON_INSTANCES[index]}:`, result.reason);
            }
        });

        if (!anyResultsFound || globalTootsMap.size === 0) {
            throw new Error(`No hashtags found for "${query}" across any instances.`);
        }

        console.log(`Phase 1 complete: Found ${globalTootsMap.size} unique toots`);

        // Phase 2: Find top related hashtags and search them in parallel
        const currentToots = Array.from(globalTootsMap.values());
        const topRelatedHashtags = extractTopHashtags(currentToots, query);

        if (topRelatedHashtags.length > 0) {
            console.log(`Phase 2: Searching ${topRelatedHashtags.length} related hashtags across all instances...`);
            console.log(`Related hashtags: ${topRelatedHashtags.join(', ')}`);

            // Create all combinations of hashtags × instances for parallel processing
            const secondarySearchPromises = [];
            for (const relatedTag of topRelatedHashtags) {
                for (const instance of MASTODON_INSTANCES) {
                    secondarySearchPromises.push(
                        searchHashtagOnInstance(instance, relatedTag, globalTootsMap)
                    );
                }
            }

            // Execute all secondary searches in parallel
            const secondaryResults = await Promise.allSettled(secondarySearchPromises);

            let additionalToots = 0;
            secondaryResults.forEach((result, index) => {
                if (result.status === 'fulfilled' && result.value > 0) {
                    additionalToots += result.value;
                } else if (result.status === 'rejected') {
                    // Don't log every failure in secondary search to avoid spam
                }
            });

            console.log(`Phase 2 complete: Added ${additionalToots} additional toots`);
        }

        // Final processing: Extract hashtags from all collected toots
        const finalToots = Array.from(globalTootsMap.values());
        console.log(`Final toot count: ${finalToots.length}`);

        return extractAndSortHashtags(finalToots, query);
    }

    // Function to search a single instance in the initial phase
    async function searchInstanceInitial(instance, query, globalTootsMap) {
        let tootsAdded = 0;

        try {
            const SEARCH_API = `${instance}/api/v2/search`;
            const TAG_TIMELINE_API = `${instance}/api/v1/timelines/tag`;
            const PUBLIC_TIMELINE_API = `${instance}/api/v1/timelines/public`;

            // Step 1: Search for hashtags
            let searchResults = { hashtags: [] };
            try {
                const searchResponse = await fetch(`${SEARCH_API}?q=${encodeURIComponent(query)}&type=hashtags&limit=5`);
                if (searchResponse.ok) {
                    searchResults = await searchResponse.json();
                }
            } catch (error) {
                // Continue with empty results
            }

            // Step 2: Get toots from found hashtags (parallel)
            const foundHashtags = searchResults.hashtags || [];
            const tagPromises = foundHashtags.slice(0, 3).map(async (tag) => {
                try {
                    const tagResponse = await fetch(`${TAG_TIMELINE_API}/${tag.name}?limit=30`);
                    if (tagResponse.ok) {
                        return await tagResponse.json();
                    }
                } catch (error) {
                    return [];
                }
                return [];
            });

            // Step 3: Get relevant toots from public timeline
            const publicPromise = (async () => {
                try {
                    const publicResponse = await fetch(`${PUBLIC_TIMELINE_API}?limit=40`);
                    if (publicResponse.ok) {
                        const publicToots = await publicResponse.json();
                        return publicToots.filter(toot => {
                            if (toot.content.toLowerCase().includes(query.toLowerCase())) {
                                return true;
                            }
                            if (toot.tags && Array.isArray(toot.tags)) {
                                return toot.tags.some(tag =>
                                    tag.name.toLowerCase().includes(query.toLowerCase())
                                );
                            }
                            return false;
                        });
                    }
                } catch (error) {
                    return [];
                }
                return [];
            })();

            // Wait for all promises to complete
            const [tagResults, publicToots] = await Promise.all([
                Promise.all(tagPromises),
                publicPromise
            ]);

            // Add all toots to global map
            const allToots = [...tagResults.flat(), ...publicToots];
            allToots.forEach(toot => {
                toot.source_instance = instance;
                if (!globalTootsMap.has(toot.id)) {
                    globalTootsMap.set(toot.id, toot);
                    tootsAdded++;
                }
            });

        } catch (error) {
            console.warn(`Error in initial search for ${instance}:`, error);
        }

        return tootsAdded;
    }

    // Function to search a specific hashtag on a specific instance
    async function searchHashtagOnInstance(instance, hashtag, globalTootsMap) {
        let tootsAdded = 0;

        try {
            const TAG_TIMELINE_API = `${instance}/api/v1/timelines/tag`;
            const tagResponse = await fetch(`${TAG_TIMELINE_API}/${hashtag}?limit=30`);

            if (tagResponse.ok) {
                const tagToots = await tagResponse.json();
                tagToots.forEach(toot => {
                    toot.source_instance = instance;
                    if (!globalTootsMap.has(toot.id)) {
                        globalTootsMap.set(toot.id, toot);
                        tootsAdded++;
                    }
                });
            }
        } catch (error) {
            // Silently handle errors in secondary searches
        }

        return tootsAdded;
    }

    // Helper function to extract top hashtags from a set of toots
    function extractTopHashtags(toots, query, limit = MAX_RELATED_HASHTAGS) {
        const hashtagCounts = {};
        const originalQuery = query.toLowerCase().replace(/^#/, '');

        toots.forEach(toot => {
            if (toot.tags && Array.isArray(toot.tags)) {
                toot.tags.forEach(tag => {
                    const name = tag.name.toLowerCase();
                    hashtagCounts[name] = (hashtagCounts[name] || 0) + 1;
                });
            }
        });

        // Convert to array, sort by frequency, and return top N (excluding original query)
        return Object.entries(hashtagCounts)
            .map(([name, count]) => name)
            .filter(name => name.toLowerCase() !== originalQuery)
            .sort((a, b) => hashtagCounts[b] - hashtagCounts[a])
            .slice(0, limit);
    }

    // Function to extract and sort all hashtags from final toot collection
    function extractAndSortHashtags(toots, query) {
        const hashtagCounts = {};
        const originalQuery = query.toLowerCase().replace(/^#/, '');

        toots.forEach(toot => {
            if (toot.tags && Array.isArray(toot.tags)) {
                toot.tags.forEach(tag => {
                    const name = tag.name.toLowerCase();
                    hashtagCounts[name] = (hashtagCounts[name] || 0) + 1;
                });
            }
        });

        // Convert to array and sort by frequency
        const sortedHashtags = Object.entries(hashtagCounts)
            .map(([name, count]) => ({
                name,
                count,
                isOriginal: name.toLowerCase() === originalQuery
            }))
            .sort((a, b) => b.count - a.count);

        return sortedHashtags;
    }

    function displayHashtags(hashtags) {
        if (hashtags.length === 0) {
            showError('No related hashtags found.');
            return;
        }

        // Maximum value for popularity determination
        const maxCount = hashtags[0].count;

        hashtags.forEach((tag, index) => {
            const listItem = document.createElement('li');
            listItem.className = 'list-group-item hashtag-card';

            // Determine popularity class
            if (tag.isOriginal) {
                listItem.classList.add('popularity-original');
            } else if (tag.count >= maxCount * 0.7) {
                listItem.classList.add('popularity-high');
            } else if (tag.count >= maxCount * 0.3) {
                listItem.classList.add('popularity-medium');
            } else {
                listItem.classList.add('popularity-low');
            }

            // Container for all elements in one row
            const contentDiv = document.createElement('div');
            contentDiv.className = 'hashtag-content d-flex align-items-center';

            // 1. Hashtag as link to Mastowall
            const hashtagLink = document.createElement('a');
            hashtagLink.className = 'hashtag-name me-3';
            hashtagLink.href = `https://rstockm.github.io/mastowall/?hashtags=${tag.name}&server=${DEFAULT_MASTOWALL_INSTANCE}`;
            hashtagLink.target = '_blank';
            hashtagLink.rel = 'noopener noreferrer';
            hashtagLink.textContent = `#${tag.name}`;

            // Stop event propagation for the link
            hashtagLink.addEventListener('click', (e) => {
                e.stopPropagation();
            });

            // 2. Progress bar in the middle with flex-grow
            const progressContainer = document.createElement('div');
            progressContainer.className = 'progress-container';

            const progressBar = document.createElement('div');
            progressBar.className = 'progress';

            const progressBarInner = document.createElement('div');
            progressBarInner.className = 'progress-bar';

            // Calculate percentage for bar length
            const percentage = (tag.count / maxCount) * 100;

            // Bar color based on popularity
            if (tag.isOriginal) {
                progressBarInner.classList.add('bg-primary');
            } else if (tag.count >= maxCount * 0.7) {
                progressBarInner.classList.add('bg-success');
            } else if (tag.count >= maxCount * 0.3) {
                progressBarInner.classList.add('bg-warning');
            } else {
                progressBarInner.classList.add('bg-secondary');
            }

            progressBarInner.style.width = `${percentage}%`;
            progressBarInner.setAttribute('aria-valuenow', percentage);
            progressBarInner.setAttribute('aria-valuemin', 0);
            progressBarInner.setAttribute('aria-valuemax', 100);

            progressBar.appendChild(progressBarInner);
            progressContainer.appendChild(progressBar);

            // 3. Count of occurrences
            const count = document.createElement('span');
            count.className = 'hashtag-count ms-3 me-4';
            count.textContent = tag.count;

            // 4. Checkbox for selection
            const checkboxContainer = document.createElement('div');
            checkboxContainer.className = 'form-check';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'form-check-input hashtag-checkbox';
            checkbox.id = `hashtag-${tag.name}`;
            checkbox.value = tag.name;

            // Select the first three hashtags by default
            if (index < MAX_SELECTED_HASHTAGS) {
                checkbox.checked = true;
                selectedHashtags.push(tag.name);
            }

            checkbox.addEventListener('change', function () {
                handleHashtagSelection(this);
            });

            // Stop event propagation for the checkbox
            checkbox.addEventListener('click', (e) => {
                e.stopPropagation();
            });

            checkboxContainer.appendChild(checkbox);

            // Assemble all elements
            contentDiv.appendChild(hashtagLink);
            contentDiv.appendChild(progressContainer);
            contentDiv.appendChild(count);
            contentDiv.appendChild(checkboxContainer);
            listItem.appendChild(contentDiv);

            // Make entire row clickable
            listItem.style.cursor = 'pointer';
            listItem.addEventListener('click', () => {
                // Toggle checkbox
                checkbox.checked = !checkbox.checked;
                // Trigger event
                const changeEvent = new Event('change');
                checkbox.dispatchEvent(changeEvent);
            });

            hashtagsList.appendChild(listItem);
        });

        // Update Mastowall button after loading hashtags
        updateMastowallButton();
    }

    // Function to manage hashtag selection (max 3)
    function handleHashtagSelection(checkbox) {
        const hashtag = checkbox.value;

        if (checkbox.checked) {
            // Check if 3 hashtags are already selected
            if (selectedHashtags.length >= MAX_SELECTED_HASHTAGS) {
                // Show warning
                alert(`You can select a maximum of ${MAX_SELECTED_HASHTAGS} hashtags. Please deselect another hashtag first.`);

                // Uncheck the checkbox
                checkbox.checked = false;
                return;
            }

            // Add hashtag to the list
            selectedHashtags.push(hashtag);
        } else {
            // Remove hashtag from the list
            const index = selectedHashtags.indexOf(hashtag);
            if (index !== -1) {
                selectedHashtags.splice(index, 1);
            }
        }

        // Update button status
        updateMastowallButton();
    }

    // Function to update the Mastowall button
    function updateMastowallButton() {
        if (createMastowallBtn) {
            if (selectedHashtags.length > 0) {
                createMastowallBtn.classList.remove('disabled');
                createMastowallBtn.setAttribute('aria-disabled', 'false');
            } else {
                createMastowallBtn.classList.add('disabled');
                createMastowallBtn.setAttribute('aria-disabled', 'true');
            }

            // Update URL for the button
            const hashtagsParam = selectedHashtags.join(',');
            createMastowallBtn.href = `https://rstockm.github.io/mastowall/?hashtags=${hashtagsParam}&server=${DEFAULT_MASTOWALL_INSTANCE}`;
        }
    }

    // Event listener for the "Create Mastowall" button
    if (createMastowallBtn) {
        createMastowallBtn.addEventListener('click', function (e) {
            if (selectedHashtags.length === 0) {
                e.preventDefault();
                alert('Please select at least one hashtag.');
            }
        });
    }

    function showError(message) {
        errorMessage.textContent = message;
        errorMessage.classList.remove('d-none');
        resultsContainer.classList.add('d-none');
    }
});