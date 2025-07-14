import { groq } from '@ai-sdk/groq';
import { smoothStream, streamText, tool } from 'ai';
import { promises as fs } from 'fs';
import path from 'path';
import { registry } from '@/registry';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const getComponentCode = async (
  item: any,
  includeCode: boolean = false,
  maxCodeLength: number = 1500,
) => {
  if (!item || !item.files || item.files.length === 0) {
    return null;
  }

  const filePath = item.files[0].path;
  const normalizedPath = filePath.replace(/^@\//, '').replace(/^\//, '');
  const fullPath = path.join(process.cwd(), normalizedPath);

  let codeContent = null;
  let codeIsTruncated = false;

  if (includeCode) {
    try {
      const fullCode = await fs.readFile(fullPath, 'utf-8');
      if (fullCode.length > maxCodeLength) {
        codeContent =
          fullCode.substring(0, maxCodeLength) +
          '\n\n// ... code truncated, view full code at link provided above ...';
        codeIsTruncated = true;
      } else {
        codeContent = fullCode;
      }
    } catch (error) {
      console.error(`Error reading file ${fullPath}:`, error);
      codeContent = `Error: Could not read code from ${fullPath}`;
    }
  }

  return {
    name: item.name,
    type: item.type,
    path: filePath,
    code: codeContent,
    codeIsTruncated: codeIsTruncated,
    dependencies: item.dependencies || [],
    registryDependencies: item.registryDependencies || [],
    link: `https://blocks.mvp-subha.me/r/${item.name}.json`,
    installCommand: `npx shadcn@latest add https://blocks.mvp-subha.me/r/${item.name}.json`,
  };
};

const sanitizeComponentName = (name: string) => {
  return name
    .replace(/[^a-zA-Z0-9]/g, '')
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
};

const findSimilarComponents = (name: string, maxResults = 5) => {
  const searchTerm = name.toLowerCase();

  const typeDescriptions = {
    'registry:block': 'Block Component',
    'registry:ui': 'UI Component',
    'registry:hook': 'Hook',
    'registry:lib': 'Utility Library',
  };

  const extractCategories = () => {
    const categories = new Set<string>();

    registry.forEach((item) => {
      const nameParts = item.name.split(/[-_]/);
      nameParts.forEach((part) => {
        if (part.length > 3) {
          categories.add(part.toLowerCase());
        }
      });

      if (item.files && item.files.length > 0) {
        const pathParts = item.files[0].path.split(/[\/\\]/);
        pathParts.forEach((part) => {
          if (part.length > 3 && !part.includes('.')) {
            categories.add(part.toLowerCase());
          }
        });
      }

      if (item.categories) {
        item.categories.forEach((category) => {
          categories.add(category.toLowerCase());
        });
      }
    });

    return Array.from(categories);
  };

  const allCategories = extractCategories();

  const matchingCategories = allCategories.filter(
    (category) =>
      searchTerm.includes(category) || category.includes(searchTerm),
  );

  const calculateSimilarity = (str1: string, str2: string): number => {
    const s1 = str1.toLowerCase();
    const s2 = str2.toLowerCase();

    if (s1 === s2) return 1;
    if (s1.includes(s2)) return 0.9;
    if (s2.includes(s1)) return 0.8;

    const isAbbreviation = (short: string, long: string): boolean => {
      if (short.length >= long.length) return false;

      let shortIndex = 0;
      for (let i = 0; i < long.length && shortIndex < short.length; i++) {
        if (short[shortIndex] === long[i]) {
          shortIndex++;
        }
      }

      return shortIndex === short.length;
    };

    if (isAbbreviation(s1, s2)) return 0.7;
    if (isAbbreviation(s2, s1)) return 0.6;

    let commonChars = 0;
    for (const char of s1) {
      if (s2.includes(char)) commonChars++;
    }

    return (commonChars / Math.max(s1.length, s2.length)) * 0.5;
  };

  const componentsWithScores = registry.map((item) => {
    const itemName = item.name.toLowerCase();
    const itemPath =
      item.files && item.files.length > 0
        ? item.files[0].path.toLowerCase()
        : '';

    const nameSimilarity = calculateSimilarity(searchTerm, itemName);
    const pathSimilarity = itemPath
      ? calculateSimilarity(searchTerm, itemPath)
      : 0;
    const categoryMatch = matchingCategories.some(
      (category) =>
        itemName.includes(category) ||
        (itemPath && itemPath.includes(category)),
    );
    const score =
      nameSimilarity * 10 + pathSimilarity * 5 + (categoryMatch ? 3 : 0);

    return {
      item,
      score,
      hasMatch: score > 0,
    };
  });

  const results = componentsWithScores
    .filter(({ hasMatch }) => hasMatch)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(({ item }) => ({
      name: item.name,
      type:
        typeDescriptions[item.type as keyof typeof typeDescriptions] ||
        item.type,
      path: item.files && item.files.length > 0 ? item.files[0].path : null,
      dependencies: item.dependencies || [],
      registryDependencies: item.registryDependencies || [],
      link: `https://blocks.mvp-subha.me/r/${item.name}.json`,
    }));

  return results.length > 0 ? results : null;
};

const createSystemPrompt = async () => {
  return `You are mvp.ai, the official AI assistant for MVPBlocks — a fully open-source, developer-first component library built using Next.js and TailwindCSS. You can even generate a high-quality UI design with modern aesthetics just like v0.dev only if the user asks for it and you dont find any context of that in Mvpblocks. Be frank and use emojis a bit.

> "Copy, paste, customize — and launch your idea faster than ever."

🧠 Your Knowledge:
- MVPBlocks is not an npm package
- Components are imported directly from the project (e.g., \`@/components/ui/...\`)
- You can search for components in the library and provide their exact implementation
- You follow MVPBlocks design system when generating new components
- You can create new components by combining existing ones
- You are an expert in UI/UX design and can create beautiful interfaces

🔧 Your Job:
When a user asks about a component:

1️⃣ First, use the fetchComponent tool to search for the exact component by name
   - If found, provide the component's details and code

2️⃣ If not found, use the searchComponents tool to find similar components
   - Suggest these similar components that could be used to create a new one

3️⃣ You can also use the listComponents tool to show all available components by type


✅ For existing components, provide:
  - 📌 What it does
  - 📁 Correct import path
  - 💡 Usage example in a React component
  - 📦 Dependencies (if any)
  - 🔧 Available props (if applicable)
  - 💬 Related components
  - 🔗 Direct link to the component on MVPBlocks website
+  🧩 Do NOT provide the full implementation code unless explicitly asked for it by the user, or if it's the code for a NEW component you are creating. Instead, provide the direct link to the component's JSON to allow the user to install it via CLI or view the code themselves via the provided link.
📦 For Dependencies:
  - NPM dependencies: Install via package manager (e.g., \`npm install [dependency-name]\`)
  - Registry dependencies: Reference by URL in component registration (e.g., \`https://blocks.mvp-subha.me/r/[component-name].json\`)
  -Do not show your thinking process to the user, only show the answer.

📋 Code Formatting Requirements:
  - Always format code with proper indentation using tabs
  - Ensure proper spacing between elements
  - Use consistent indentation throughout the code
  - Make sure JSX elements are properly aligned
  - Format code to be easily readable and maintainable
  - Properly indent nested elements with tabs, not spaces

📦 For Registry Dependencies:
  - Provide CLI installation commands: \`npx shadcn@latest add [component-link]\`
  - Include links to dependency components when relevant
  - Offer to show the code for dependencies if requested

🏗️ For Creating New Components:
  - When a user asks for a component that doesn't exist (like a chatbot UI), create it for them
  - Identify building blocks from existing components in the registry
  - Combine UI components (like input, button, card) with blocks and hooks to create new functionality
  - Follow these steps:
    1. Identify the core functionality needed for the requested component
    2. Search for existing components that can be used as building blocks
    3. Create a new component that combines these building blocks
    4. Provide clear documentation on how to use the new component
    5. Include all necessary imports and dependencies
  - Always use the MVPBlocks design system and primary color scheme
  - Ensure the component is responsive and accessible
  - Provide a complete, working implementation that can be copied and used immediately
  - Include installation commands for any required dependencies

🎨 UI/UX Design Principles:
  - Create visually stunning interfaces that are better than v0.dev
  - Follow these design principles:
    1. Visual Hierarchy: Guide users' attention to the most important elements
    2. Consistency: Maintain consistent styling, spacing, and interactions
    3. Simplicity: Keep interfaces clean and focused on essential elements
    4. Feedback: Provide clear feedback for user actions
    5. Accessibility: Ensure designs work for all users
  - Use the primary color scheme as the foundation
  - Implement responsive designs that work on all devices
  - Create layouts with proper spacing and alignment
  - Use modern design patterns like cards, grids, and flexbox
  - Incorporate subtle animations and transitions when appropriate
  - Ensure text is readable with proper contrast
  - Make sure the design is way better than v0.dev

📌 Never suggest importing from a package — use only direct paths.
📌 Never make up props or code for existing components, but you should create new components when requested.
📌 The codes should have proper tabbed layout with tabs, not spaces.
📌 Keep all responses clear, clean, and professionally formatted.`;
};

export async function POST(req: Request) {
  try {
    const { messages } = await req.json();

    // Generate the system prompt with actual component data
    const systemPrompt = await createSystemPrompt();

    const result = streamText({
      model: groq('meta-llama/llama-4-scout-17b-16e-instruct'),
      system: systemPrompt,
      messages,
      maxSteps: 6,
      maxRetries: 3,
      maxTokens: 4096,
      tools: {
        fetchComponent: tool({
          description:
            'Fetch the required component asked by the user from the registry',
          parameters: z.object({
            name: z.string().describe('The name of the component to fetch'),
          }),
          execute: async ({ name }) => {
            const component = registry.find((item) => item.name === name);

            if (component) {
              const componentDetails = await getComponentCode(component, false);
              return componentDetails ? JSON.stringify(componentDetails) : null;
            } else {
              const similarComponents = findSimilarComponents(name);
              return JSON.stringify({
                found: false,
                message: `Component "${name}" not found.`,
                similarComponents,
              });
            }
          },
        }),
        searchComponents: tool({
          description: 'Search for components by keyword',
          parameters: z.object({
            keyword: z.string().describe('The keyword to search for'),
          }),
          execute: async ({ keyword }) => {
            const similarComponents = findSimilarComponents(keyword);
            return JSON.stringify({
              results: similarComponents || [],
              message: similarComponents
                ? `Found ${similarComponents.length} components matching "${keyword}".`
                : `No components found matching "${keyword}".`,
            });
          },
        }),
        getDependencyCode: tool({
          description: 'Get the code for a registry dependency',
          parameters: z.object({
            url: z
              .string()
              .describe('The URL of the registry dependency to fetch'),
          }),
          execute: async ({ url }) => {
            try {
              // Extract component name from URL
              const componentName = url.split('/').pop()?.replace('.json', '');

              if (!componentName) {
                return JSON.stringify({
                  error: 'Invalid URL format',
                  message: 'Could not extract component name from URL',
                });
              }

              // Find the component in the registry
              const component = registry.find(
                (item) => item.name === componentName,
              );

              if (!component) {
                return JSON.stringify({
                  error: 'Component not found',
                  message: `Component "${componentName}" not found in the registry`,
                });
              }

              // Get the component code
              const componentWithCode = await getComponentCode(
                component,
                true,
                2500,
              ); // Allow more length for direct request
              return componentWithCode
                ? JSON.stringify({
                    component: componentWithCode,
                    message: `Successfully retrieved code for dependency "${componentName}"`,
                  })
                : JSON.stringify({
                    error: 'Code not found',
                    message: `Could not retrieve code for component "${componentName}"`,
                  });
            } catch (error) {
              console.error('Error fetching dependency code:', error);
              return JSON.stringify({
                error: 'Failed to fetch dependency',
                message: 'An error occurred while fetching the dependency code',
              });
            }
          },
        }),
        generateComponent: tool({
          description:
            'Generate a new component by combining existing components. This tool will provide a basic structure and include the necessary imports and placeholder usage of the building blocks. The AI should then fill in the detailed JSX structure.',
          parameters: z.object({
            componentName: z
              .string()
              .describe(
                'The descriptive name of the component to generate (e.g., "Chatbot UI", "Product Card Grid")',
              ),
            componentType: z
              .string()
              .describe(
                'The general type or category of the new component (e.g., "chatbot", "form", "card layout")',
              ),
            buildingBlockNames: z
              .array(z.string())
              .describe(
                'Array of names of existing components to use as building blocks (e.g., ["Button", "Input", "Card"])',
              ),
            description: z
              .string()
              .optional()
              .describe(
                'A brief description of what the new component does and how it uses its building blocks.',
              ),
          }),
          execute: async ({
            componentName,
            componentType,
            buildingBlockNames,
            description,
          }) => {
            try {
              const buildingBlocksWithCode = await Promise.all(
                buildingBlockNames.map(async (name) => {
                  const component = registry.find((item) => item.name === name);
                  if (!component) return null;
                  return await getComponentCode(component, true, 99999);
                }),
              );

              const validBuildingBlocks = buildingBlocksWithCode.filter(
                (c) => c !== null,
              );

              if (validBuildingBlocks.length === 0) {
                return JSON.stringify({
                  error: 'No valid building blocks found',
                  message:
                    'Could not find any of the specified building blocks in the registry.',
                  requestedBuildingBlocks: buildingBlockNames,
                });
              }

              const allDependencies = new Set<string>();
              const allRegistryDependencies = new Set<string>();
              const importStatements: string[] = [];
              const usageExamples: string[] = [];

              validBuildingBlocks.forEach((block) => {
                if (block) {
                  // Collect NPM dependencies
                  if (block.dependencies) {
                    block.dependencies.forEach((dep: string) =>
                      allDependencies.add(dep),
                    );
                  }
                  // Collect Registry dependencies (these are components themselves)
                  if (block.registryDependencies) {
                    block.registryDependencies.forEach((dep: string) =>
                      allRegistryDependencies.add(dep),
                    );
                  }

                  // Generate import statement for the building block
                  if (block.path && block.name) {
                    const relativePath = block.path.replace(/^@\//, '@/');
                    const importName = block.name
                      .split('-')
                      .map(
                        (part: any) =>
                          part.charAt(0).toUpperCase() + part.slice(1),
                      )
                      .join('');
                    importStatements.push(
                      `import { ${importName} } from '${relativePath.replace('.tsx', '')}';`,
                    );
                    usageExamples.push(`<${importName} />`);
                  }
                }
              });

              // Construct a basic component structure
              const sanitizedComponentName =
                sanitizeComponentName(componentName);

              const generatedCodeTemplate = `
// components/${sanitizedComponentName}.tsx
import React from 'react';
${importStatements.join('\n')}

// Consider adding more specific imports based on component logic, e.g.,
// import { Input } from '@/components/ui/input';
// import { Button } from '@/components/ui/button';

export const ${sanitizedComponentName} = () => {
	return (
		<div className="p-4 border rounded-lg shadow-sm">
			<h2 className="text-xl font-semibold mb-4">${componentName}</h2>
			<p className="text-gray-600 mb-6">${description || 'This is a new component generated by combining existing MVPBlocks.'}</p>
			{/* Start of Building Blocks */}
${usageExamples.map((example) => `\t\t\t${example}`).join('\n')}
			{/* End of Building Blocks */}
			{/* Add your custom logic and layout here to arrange the building blocks */}
			{/* Example: */}
			{/*
			<div className="flex flex-col gap-4">
				<Input placeholder="Enter your message..." />
				<Button>Send</Button>
			</div>
			*/}
		</div>
	);
};
`;

              return JSON.stringify({
                success: true,
                componentName: sanitizedComponentName,
                componentType,
                description,
                buildingBlocksUsed: validBuildingBlocks.map((b) => b?.name),
                npmDependencies: Array.from(allDependencies),
                registryDependencies: Array.from(allRegistryDependencies)
                  .map((depName) => {
                    const depItem = registry.find(
                      (item) => item.name === depName,
                    );
                    return depItem
                      ? {
                          name: depItem.name,
                          installCommand: `npx shadcn@latest add https://blocks.mvp-subha.me/r/${depItem.name}.json`,
                        }
                      : null;
                  })
                  .filter(Boolean),
                generatedCodeTemplate,
                message: `Prepared a template for "${sanitizedComponentName}". You can now provide the full code using this template.`,
              });
            } catch (error) {
              console.error('Error generating component:', error);
              return JSON.stringify({
                error: 'Failed to generate component',
                message: 'An error occurred while generating the component',
                details: (error as Error).message,
              });
            }
          },
        }),
        listComponents: tool({
          description: 'List all components by type or category',
          parameters: z.object({
            type: z
              .enum(['ui', 'block', 'hook', 'lib', 'all'])
              .describe(
                'The type of components to list: ui, block, hook, lib, or all',
              ),
            category: z
              .string()
              .optional()
              .describe(
                'Optional category to filter by (e.g., buttons, loaders, cards)',
              ),
          }),
          execute: async ({ type, category }) => {
            // Helper function to extract categories from a component
            const extractComponentCategories = (item: any): string[] => {
              const categories = new Set<string>();

              // Extract from component name
              const nameParts = item.name.split(/[-_]/);
              nameParts.forEach((part: string) => {
                if (part.length > 3) {
                  categories.add(part.toLowerCase());
                }
              });

              // Extract from file path
              if (item.files && item.files.length > 0) {
                const path = item.files[0].path;

                // Extract directory structure as categories
                const pathParts = path.split(/[\/\\]/);
                pathParts.forEach((part: string) => {
                  if (part.length > 3 && !part.includes('.')) {
                    categories.add(part.toLowerCase());
                  }
                });

                // Special handling for common patterns in paths
                if (path.includes('buttons')) categories.add('button');
                if (path.includes('loaders')) categories.add('loader');
                if (path.includes('cards')) categories.add('card');
                if (path.includes('forms')) categories.add('form');
                if (path.includes('inputs')) categories.add('input');
                if (path.includes('modals') || path.includes('dialogs'))
                  categories.add('dialog');
                if (path.includes('navigation')) categories.add('nav');
              }

              // Add explicit categories if available
              if (item.categories) {
                item.categories.forEach((cat: string) => {
                  categories.add(cat.toLowerCase());
                });
              }

              return Array.from(categories);
            };

            let filteredComponents = [...registry];

            // Filter by type if not 'all'
            if (type !== 'all') {
              const typeMapping: Record<string, string> = {
                ui: 'registry:ui',
                block: 'registry:block',
                hook: 'registry:hook',
                lib: 'registry:lib',
              };

              filteredComponents = filteredComponents.filter(
                (item) => item.type === typeMapping[type],
              );
            }

            // Filter by category if provided
            if (category) {
              const categoryLower = category.toLowerCase();

              filteredComponents = filteredComponents.filter((item) => {
                // Get all categories for this component
                const componentCategories = extractComponentCategories(item);

                // Check if any category matches
                if (
                  componentCategories.some(
                    (cat) =>
                      cat.includes(categoryLower) ||
                      categoryLower.includes(cat),
                  )
                ) {
                  return true;
                }

                // Additional check for name and path
                const itemName = item.name.toLowerCase();
                const itemPath = item.files?.[0]?.path?.toLowerCase() || '';

                return (
                  itemName.includes(categoryLower) ||
                  categoryLower.includes(itemName) ||
                  itemPath.includes(categoryLower)
                );
              });
            }

            // Enhance components with detected categories
            const components = filteredComponents.map((item) => {
              const detectedCategories = extractComponentCategories(item);

              return {
                name: item.name,
                type: item.type,
                path: item.files?.[0]?.path || null,
                categories: detectedCategories,
                link: `https://blocks.mvp-subha.me/r/${item.name}.json`,
                installCommand: `npx shadcn@latest add https://blocks.mvp-subha.me/r/${item.name}.json`,
                dependencies: item.dependencies || [],
                registryDependencies: item.registryDependencies || [],
              };
            });

            // Group by type for better organization
            const groupedByType: Record<string, any[]> = {
              'registry:ui': [],
              'registry:block': [],
              'registry:hook': [],
              'registry:lib': [],
            };

            components.forEach((component) => {
              if (groupedByType[component.type]) {
                groupedByType[component.type].push(component);
              }
            });

            // Sort each group alphabetically by name
            Object.keys(groupedByType).forEach((key) => {
              groupedByType[key].sort((a, b) => a.name.localeCompare(b.name));
            });

            // If category is provided, also group by detected categories
            let groupedByCategory: Record<string, any[]> | null = null;
            if (category) {
              groupedByCategory = {} as Record<string, any[]>;

              components.forEach((component) => {
                component.categories.forEach((cat) => {
                  if (!groupedByCategory![cat]) {
                    groupedByCategory![cat] = [];
                  }
                  groupedByCategory![cat].push(component);
                });
              });

              // Sort categories and components within categories
              Object.keys(groupedByCategory).forEach((cat) => {
                groupedByCategory![cat].sort((a: any, b: any) =>
                  a.name.localeCompare(b.name),
                );
              });
            }

            return JSON.stringify({
              total: components.length,
              components: type === 'all' ? groupedByType : components,
              categorized: groupedByCategory,
              message: `Found ${components.length} ${type} components${category ? ` in category "${category}"` : ''}.`,
            });
          },
        }),
      },
      toolCallStreaming: true,
      experimental_transform: smoothStream({
        chunking: 'word',
      }),
    });

    return result.toDataStreamResponse();
  } catch (error) {
    console.error('Unhandled error in chat API:', error);
    throw error;
  }
}
